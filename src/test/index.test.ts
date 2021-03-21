import {
    AuthorKeypair,
    IStorage,
    IStorageAsync,
    Query,
    StorageMemory,
    ValidationError,
    ValidatorEs4,
    WriteResult,
    generateAuthorKeypair,
    isErr,
    notErr,
    sha256base32,
} from 'earthstar';
import {
    EdgeContent,
    GRAPH_PATH_PREFIX,
    GraphQuery,
    _globToEarthstarQueryAndPathRegex,
    _graphQueryToGlob,
    findEdges,
    validateGraphQuery,
    writeEdge,
} from '../index';

import t from 'tap';
//t.runOnly = true;

let log = console.log;

const workspace = '+gardening.ajfoaifrjaoj';
const keypair1 = generateAuthorKeypair('onee') as AuthorKeypair;
const keypair2 = generateAuthorKeypair('twoo') as AuthorKeypair;
const author1 = keypair1.address;
const author2 = keypair2.address;

//================================================================================

/* TEST DATA
source   owner:kind   dest
-----------------------------

 1 @onee   @one:FOLLOWED  @twoo
 
 2 @onee   @onee:AUTHORED  /blog/post/123.md
 3 @twoo   @twoo:LIKED   /blog/post/123.md
 4 @twoo   @twoo:REACTED{reaction: ':)'}   /blog/post/123.md
 
 5 @twoo   @twoo:AUTHORED   /blog/comment/456.md
 6 /blog/comment/456.md   @twoo:COMMENTS_ON   /blog/post/123.m3
 
 7 /blog/post/123.md   @onee:LINKED_TO   http://www.example.com
 
// a bidirectional link from both sides:

 8 /wiki/cats.md     common:LINKED_TO  /wiki/kittens.md
 9 /wiki/kittens.md  common:LINKED_TO  /wiki/cats.md

// a single non-directed link:

10 @onee   @onee:-IS_SAME_PERSON_AS-   @twoo

*/

let blogPath = '/blog/post/123.md';
let commentPath = '/blog/comment/456.md';
let externalUrl = 'http://www.example.com';
let wikiPath1 = '/wiki/cats.md';
let wikiPath2 = '/wiki/kittens.md';

let makeTestEdges = () => {
    let edgesByAuthor1: Record<string, EdgeContent> = {};
    let edgesByAuthor2: Record<string, EdgeContent> = {};

    // 1
    edgesByAuthor1.one = {
        source: author1,
        kind: 'FOLLOWED',
        dest: author2,
        owner: author1,
    };

    // 2
    edgesByAuthor1.two = {
        source: author1,
        kind: 'AUTHORED',
        dest: blogPath,
        owner: author1,
    };

    // 3
    edgesByAuthor2.three = {
        source: author2,
        kind: 'LIKED',
        dest: blogPath,
        owner: author2,
    };

    // 4
    edgesByAuthor2.four = {
        source: author2,
        kind: 'REACTED',
        dest: blogPath,
        owner: author2,
        data: { reaction: ':)' },
    };

    // 5
    edgesByAuthor2.five = {
        source: author2,
        kind: 'AUTHORED',
        dest: commentPath,
        owner: author2,
    };

    // 6
    edgesByAuthor2.six = {
        source: commentPath,
        kind: 'COMMENTS_ON',
        dest: blogPath,
        owner: author2,
    };

    // 7
    edgesByAuthor1.seven = {
        source: blogPath,
        kind: 'LINKED_TO',
        dest: externalUrl,
        owner: author1,
    };

    // 8 bidirectional link from both sides:
    edgesByAuthor2.eight = {
        source: wikiPath1,
        kind: 'LINKED_TO',
        dest: wikiPath2,
        owner: 'common',
    };

    // 9 bidirectional link from both sides:
    edgesByAuthor2.nine = {
        source: wikiPath2,
        kind: 'LINKED_TO',
        dest: wikiPath1,
        owner: 'common',
    };

    // 10 a single non-directed link.
    // In a non-directed link, always put
    // the smaller source first, for consistency.
    let nodes = [author1, author2];
    nodes.sort();
    edgesByAuthor1.ten = {
        source: nodes[0],
        kind: '-IS_SAME_PERSON_AS-',
        dest: nodes[1],
        owner: author1,
    };

    return { edgesByAuthor1, edgesByAuthor2 };
}

let TEST_EDGES = makeTestEdges();

let addTestEdges = async (testEdges: Record<string, Record<string, EdgeContent>>, storage: IStorage | IStorageAsync): Promise<boolean> => {
    let { edgesByAuthor1, edgesByAuthor2 } = testEdges;
    let success = true;
    for (let edge of Object.values(edgesByAuthor1)) {
        let result = await writeEdge(storage, keypair1, edge);
        if (result !== WriteResult.Accepted) {
            console.error(result);
            success = false;
        }
    }
    for (let edge of Object.values(edgesByAuthor2)) {
        let result = await writeEdge(storage, keypair2, edge);
        if (result !== WriteResult.Accepted) {
            console.error(result);
            success = false;
        }
    }
    return success;
}

//================================================================================

t.test('writeEdge: basics', async (t) => {
    let storage = new StorageMemory([ValidatorEs4], workspace);

    let writeSuccess = await addTestEdges(TEST_EDGES, storage);
    t.true(writeSuccess, 'write successful');

    let paths = await storage.paths();
    t.same(paths.length, 10, 'expected number of edges in test data; all were written successfully');

    storage.close();
    t.done();
});

t.test('writeEdge: keypair permissions', async (t) => {
    let storage = new StorageMemory([ValidatorEs4], workspace);

    let result = await writeEdge(storage, keypair1, {
        source: 'aaa',
        kind: 'LIKED',
        dest: 'bbb',
        owner: author2,  // does not match keypair1 above
    });
    t.true(result instanceof ValidationError, 'should return ValidationError when doing earthstar write with keypair 1 but edge owner 2');

    // write to a common edge
    let result2 = await writeEdge(storage, keypair1, {
        source: 'aaa',
        kind: 'LIKED',
        dest: 'bbb',
        owner: 'common',
        data: '1',
    });
    t.same(result2, WriteResult.Accepted, 'ok to wite with "common" owner from any keypair');
    for (let content of await storage.contents()) {
        t.same(JSON.parse(content).data, '1', 'data was written');
    }

    // overwrite a common edge with a different author
    let result3 = await writeEdge(storage, keypair2, {
        source: 'aaa',
        kind: 'LIKED',
        dest: 'bbb',
        owner: 'common',
        data: '2',
    });
    t.same(result3, WriteResult.Accepted, 'can overwrite a common edge with a different author');
    for (let content of await storage.contents()) {
        t.same(JSON.parse(content).data, '2', 'data was overwritten');
    }

    storage.close();
    t.done();
});

//================================================================================

t.test('validateGraphQuery', async (t) => {
    interface Vector {
        graphQuery: GraphQuery,
        shouldBeValid: boolean,
    };
    let vectors: Vector[] = [
        { shouldBeValid: true,  graphQuery: {}},

        { shouldBeValid: true,  graphQuery: { owner: 'common'}},
        { shouldBeValid: true,  graphQuery: { owner: author1}},
        { shouldBeValid: false, graphQuery: { owner: '~' + author1}},
        { shouldBeValid: false, graphQuery: { owner: '@fooo'}},

        { shouldBeValid: true,  graphQuery: { kind: 'foo'}},
        { shouldBeValid: false, graphQuery: { kind: '/'}},
        { shouldBeValid: false, graphQuery: { kind: '*'}},
        { shouldBeValid: false, graphQuery: { kind: '?'}},
        { shouldBeValid: false, graphQuery: { kind: 'foo bar'}},
    ];
    for (let { graphQuery, shouldBeValid } of vectors) {
        let err = validateGraphQuery(graphQuery);
        t.same(notErr(err), shouldBeValid, `should${shouldBeValid ? '' : ' not'} be valid: ${JSON.stringify(graphQuery)}`);
    }
    t.done();
});

t.test('_graphQueryToGlob', async (t) => {
    interface Vector {
        graphQuery: GraphQuery,
        glob: string,
    };
    let vectors: Vector[] = [
        { graphQuery: {}, glob: `${GRAPH_PATH_PREFIX}/source:*/owner:*/kind:*/dest:*.json` },
        { graphQuery: {owner: 'common'}, glob: `${GRAPH_PATH_PREFIX}/source:*/owner:common/kind:*/dest:*.json` },
        { graphQuery: {owner: author1}, glob: `${GRAPH_PATH_PREFIX}/source:*/owner:~${author1}/kind:*/dest:*.json` },
        { graphQuery: {kind: 'foo'}, glob: `${GRAPH_PATH_PREFIX}/source:*/owner:*/kind:foo/dest:*.json` },
        { graphQuery: {source: 'a'}, glob: `${GRAPH_PATH_PREFIX}/source:${sha256base32('a')}/owner:*/kind:*/dest:*.json` },
        { graphQuery: {dest: 'a'}, glob: `${GRAPH_PATH_PREFIX}/source:*/owner:*/kind:*/dest:${sha256base32('a')}.json` },
    ];
    for (let { graphQuery, glob } of vectors) {
        let returnedGlob = _graphQueryToGlob(graphQuery);
        t.same(returnedGlob, glob, `glob should match for graphQuery ${JSON.stringify(graphQuery)}`);
    }
    t.done();
});

t.test('_globToEarthstarQueryAndPathRegex', async (t) => {
    interface Vector {
        glob: string,
        esQuery: Query,
        pathRegex: string | null,
        matchingPaths: string[],
        nonMatchingPaths: string[],
    };
    let vectors: Vector[] = [
        {
            // no asterisks
            glob: '/a',
            esQuery: { path: '/a', contentLengthGt: 0, },  // exact path, not startsWith and endsWith
            pathRegex: null,  // no regex is needed
            matchingPaths: ['/a'],
            nonMatchingPaths: ['/', 'a', '/b', '-/a', '/a-'],
        },
        {
            // one asterisk at beginning
            glob: '*a.txt',
            esQuery: { pathEndsWith: 'a.txt', contentLengthGt: 0, },
            pathRegex: null,  // no regex needed
            matchingPaths: [
                'a.txt',
                '-a.txt',
                '----a.txt',
                '/x/x/xa.txt',
            ],
            nonMatchingPaths: [
                'a-txt',  // the dot should not become a wildcard
                'a.txt-',  // no extra stuff at end
            ],
        },
        {
            // one asterisk at end
            glob: '/abc*',
            esQuery: { pathStartsWith: '/abc', contentLengthGt: 0, },
            pathRegex: null,  // no regex needed
            matchingPaths: [
                '/abc',
                '/abc-',
                '/abc/xyz.foo',
            ],
            nonMatchingPaths: [
                'abc',
                '-/abc/',
            ],
        },
        {
            // one asterisk in the middle
            glob: '/a*a.txt',
            esQuery: { pathStartsWith: '/a', pathEndsWith: 'a.txt', contentLengthGt: 0, },
            pathRegex: '^/a.*a\\.txt$',
            matchingPaths: [
                '/aa.txt',
                '/a/a.txt',
                '/aaaa.txt',
                '/aa/aa.txt',
                '/a-----a.txt',
            ],
            nonMatchingPaths: [
                '/a.txt',  // the prefix and suffix should not be able to overlap
                '/aa-txt',  // the dot should not become a wildcard
                '-/aa.txt',  // no extra stuff at beginning
                '/aa.txt-',  // no extra stuff at end
                '-/a-a.txt-',
            ],
        },
        {
            // one asterisk at start and one in the middle
            glob: '*a*b',
            esQuery: { pathEndsWith: 'b', contentLengthGt: 0, },
            pathRegex: '^.*a.*b$',
            matchingPaths: [
                'ab',
                '-ab',
                'a-b',
                '-a-b',
                '---a---b',
            ],
            nonMatchingPaths: [
                'ab-',
                'aa',
            ],
        },
        {
            // one asterisk at end and one in the middle
            glob: 'a*b*',
            esQuery: { pathStartsWith: 'a', contentLengthGt: 0, },
            pathRegex: '^a.*b.*$',
            matchingPaths: [
                'ab',
                'ab-',
                'a-b',
                'a-b-',
                'a---b---',
            ],
            nonMatchingPaths: [
                '-ab',
                'aa',
            ],
        },
        {
            // one asterisk at start and one at end
            glob: '*abc*',
            esQuery: { contentLengthGt: 0, },
            pathRegex: '^.*abc.*$',
            matchingPaths: [
                'abc',
                'abc-',
                '-abc',
                '-abc-',
                '---abc---',
            ],
            nonMatchingPaths: [
                'ac',
            ],
        },
        {
            // one asterisk at start, one in middle, one at end
            glob: '*a*b*',
            esQuery: { contentLengthGt: 0, },
            pathRegex: '^.*a.*b.*$',
            matchingPaths: [
                'ab',
                'ab-',
                '-ab',
                '-ab-',
                '---ab---',
                '---a----b---',
                'a-b',
                '-a-b-',
            ],
            nonMatchingPaths: [
                'ac',
            ],
        },
        {
            // multiple asterisks not at the start or end
            glob: '/foo:*/bar:*.json',
            esQuery: { pathStartsWith: '/foo:', pathEndsWith: '.json', contentLengthGt: 0, },
            pathRegex: '^/foo:.*/bar:.*\\.json$',
            matchingPaths: [
                '/foo:/bar:.json',
                '/foo:a/bar:a.json',
                '/foo:-----/bar:-----.json',
            ],
            nonMatchingPaths: [
                '/foo:.json',  // middle parts should be present
                '-/foo:a/bar:a.json',
                '/foo:a/bar:a.json-',
            ],
        },
    ];

    for (let vector of vectors) {
        let { glob, esQuery, pathRegex, matchingPaths, nonMatchingPaths } = vector;

        let result = _globToEarthstarQueryAndPathRegex(glob);

        //log('---');
        //log(JSON.stringify({
        //    ...vector,
        //    result,
        //}, null, 4));

        t.same(result.query, esQuery, 'query is as expected: ' + glob);
        t.same(result.pathRegex, pathRegex, 'regex is as expected: ' + glob);
        if (result.pathRegex != null) {
            let resultRe = new RegExp(result.pathRegex);
            for (let match of matchingPaths) {
                t.true(resultRe.test(match), 'regex should match: ' + match);
            }
            for (let nonMatch of nonMatchingPaths) {
                t.false(resultRe.test(nonMatch), 'regex should not match: ' + nonMatch);
            }
        }
    }

    t.done();
});

t.test('findEdges', async (t) => {
    let storage = new StorageMemory([ValidatorEs4], workspace);
    
    let writeSuccess = await addTestEdges(TEST_EDGES, storage);
    t.true(writeSuccess, 'write successful');
    
    interface TestCase {
        desc: string,
        graphQuery: GraphQuery,
        extraQuery?: Query,
        expectedEdges: EdgeContent[],
    }
    
    let testCases: TestCase[] = [
        {
            desc: `Source is ${author1.slice(0, 10)}...`,
            graphQuery: {
                source: author1,
            },
            expectedEdges: [
                TEST_EDGES.edgesByAuthor1.one,
                TEST_EDGES.edgesByAuthor1.two,
                TEST_EDGES.edgesByAuthor1.ten,
            ],
        },
        {
            desc: 'Kind is "REACTED"',
            graphQuery: {
                kind: 'REACTED',
            },
            expectedEdges: [
                TEST_EDGES.edgesByAuthor2.four,
            ],
        },
        {
            desc: `Destination is ${blogPath}`,
            graphQuery: {
                dest: blogPath
            },
            expectedEdges: [
                TEST_EDGES.edgesByAuthor1.two,
                TEST_EDGES.edgesByAuthor2.three,
                TEST_EDGES.edgesByAuthor2.four,
                TEST_EDGES.edgesByAuthor2.six,
            ],
        },
        {
            desc: `Owner is ${author2}`,
            graphQuery: {
                owner: author2
            },
            expectedEdges: [
                TEST_EDGES.edgesByAuthor2.three,
                TEST_EDGES.edgesByAuthor2.four,
                TEST_EDGES.edgesByAuthor2.five,
                TEST_EDGES.edgesByAuthor2.six,
            ],
        },
        {
            desc: `Owner is "common"`,
            graphQuery: {
                owner: 'common',
            },
            expectedEdges: [
                TEST_EDGES.edgesByAuthor2.eight,
                TEST_EDGES.edgesByAuthor2.nine,
            ],
        },
        {
            desc: `Query for several things at once`,
            graphQuery: {
                source: blogPath,
                kind: 'LINKED_TO',
                dest: externalUrl,
                owner: author1,
            },
            expectedEdges: [
                TEST_EDGES.edgesByAuthor1.seven,
            ],
        },
        {
            desc: `Query with no results`,
            graphQuery: {
                source: 'nothing uses this source',
            },
            expectedEdges: [],
        },
        {
            desc: `Empty query returns every edge`,
            graphQuery: {
            },
            expectedEdges:
                Object.values(TEST_EDGES.edgesByAuthor1).concat(
                Object.values(TEST_EDGES.edgesByAuthor2)),
        },
        /*
        // TODO: delete a doc so we can test this.
        {
            name: 'Kind is REACTED and doc is deleted',
            graphQuery: {
                kind: 'REACTED',
            },
            // Normally we skip deleted documents.
            // If we want them, we have to add an extraQuery.
            extraQuery: {
                contentLength: 0
            }
        }
        */
    ];
    
    for (let { desc, graphQuery, extraQuery, expectedEdges } of testCases) {
        log('-------------------- ' + desc);
        log(JSON.stringify(graphQuery, null, 4));
        log('  -->');

        let docs = findEdges(storage, graphQuery, extraQuery);
        if (isErr(docs)) {
            t.fail(desc + ': findEdges failed with error: ' + docs);
            continue;
        }

        let actualEdges = docs.map(d => JSON.parse(d.content)) as any[] as EdgeContent[];
        log(actualEdges.map(edge => JSON.stringify(edge, null, 4)).join('\n'));
        t.same(new Set(actualEdges), new Set(expectedEdges), desc + ': edges should match');
    }

    storage.close()
    
    t.done();
})

// TODO: test findEdgesAsync
