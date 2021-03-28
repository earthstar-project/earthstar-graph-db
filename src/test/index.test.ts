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
} from 'earthstar';
import {
    GraphEdgeContent,
    GraphQuery,
    findEdgesSync,
    validateGraphQuery,
    writeEdgeAsync,
    deleteEdgeAsync,
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

// a deleted link:

11 @onee  @one:DELETED  "something"

*/

let blogPath = '/blog/post/123.md';
let commentPath = '/blog/comment/456.md';
let externalUrl = 'http://www.example.com';
let wikiPath1 = '/wiki/cats.md';
let wikiPath2 = '/wiki/kittens.md';

let makeTestEdges = () => {
    let edgesByAuthor1: Record<string, GraphEdgeContent> = {};
    let edgesByAuthor2: Record<string, GraphEdgeContent> = {};

    // 1
    edgesByAuthor1.one = {
        appName: 'mygraph',
        source: author1,
        kind: 'FOLLOWED',
        dest: author2,
        owner: author1,
    };

    // 2
    edgesByAuthor1.two = {
        appName: 'mygraph',
        source: author1,
        kind: 'AUTHORED',
        dest: blogPath,
        owner: author1,
    };

    // 3
    edgesByAuthor2.three = {
        appName: 'mygraph',
        source: author2,
        kind: 'LIKED',
        dest: blogPath,
        owner: author2,
    };

    // 4
    edgesByAuthor2.four = {
        appName: 'mygraph',
        source: author2,
        kind: 'REACTED',
        dest: blogPath,
        owner: author2,
        data: { reaction: ':)' },
    };

    // 5
    edgesByAuthor2.five = {
        appName: 'mygraph',
        source: author2,
        kind: 'AUTHORED',
        dest: commentPath,
        owner: author2,
    };

    // 6
    edgesByAuthor2.six = {
        appName: 'mygraph',
        source: commentPath,
        kind: 'COMMENTS_ON',
        dest: blogPath,
        owner: author2,
    };

    // 7
    edgesByAuthor1.seven = {
        appName: 'mygraph',
        source: blogPath,
        kind: 'LINKED_TO',
        dest: externalUrl,
        owner: author1,
    };

    // 8 bidirectional link from both sides:
    edgesByAuthor2.eight = {
        appName: 'mygraph',
        source: wikiPath1,
        kind: 'LINKED_TO',
        dest: wikiPath2,
        owner: 'common',
    };

    // 9 bidirectional link from both sides:
    edgesByAuthor2.nine = {
        appName: 'mygraph',
        source: wikiPath2,
        kind: 'LINKED_TO',
        dest: wikiPath1,
        owner: 'common',
    };

    // 10 a single non-directed link.
    // In a non-directed link, always put
    // the smaller source first, for consistency.
    let sources = [author1, author2];
    sources.sort();
    edgesByAuthor1.ten = {
        appName: 'mygraph',
        source: sources[0],
        kind: '-IS_SAME_PERSON_AS-',
        dest: sources[1],
        owner: author1,
    };

    // 11 a deleted edge
    edgesByAuthor1.eleven = {
        appName: 'mygraph',
        source: author1,
        kind: 'DELETED',
        dest: 'something',
        owner: author1,
    };

    return { edgesByAuthor1, edgesByAuthor2 };
}

let TEST_EDGES = makeTestEdges();

let addTestEdges = async (testEdges: Record<string, Record<string, GraphEdgeContent>>, storage: IStorage | IStorageAsync): Promise<boolean> => {
    let { edgesByAuthor1, edgesByAuthor2 } = testEdges;
    let success = true;
    for (let edge of Object.values(edgesByAuthor1)) {
        let result = await writeEdgeAsync(storage, keypair1, edge);
        if (result !== WriteResult.Accepted) {
            console.error(result);
            success = false;
        }
    }
    for (let edge of Object.values(edgesByAuthor2)) {
        let result = await writeEdgeAsync(storage, keypair2, edge);
        if (result !== WriteResult.Accepted) {
            console.error(result);
            success = false;
        }
    }
    await deleteEdgeAsync(storage, keypair1, edgesByAuthor1.eleven);
    return success;
}

//================================================================================

t.test('writeEdge: basics', async (t) => {
    let storage = new StorageMemory([ValidatorEs4], workspace);

    let writeSuccess = await addTestEdges(TEST_EDGES, storage);
    t.true(writeSuccess, 'write successful');

    let paths = await storage.paths();
    t.same(paths.length, 11, 'expected number of edges in test data; all were written successfully');

    storage.close();
    t.done();
});

t.test('writeEdge: keypair permissions', async (t) => {
    let storage = new StorageMemory([ValidatorEs4], workspace);

    let result = await writeEdgeAsync(storage, keypair1, {
        appName: 'mygraph',
        source: 'aaa',
        kind: 'LIKED',
        dest: 'bbb',
        owner: author2,  // does not match keypair1 above, will be invalid
    });
    t.true(result instanceof ValidationError, 'should return ValidationError when doing earthstar write with keypair 1 but edge owner 2');

    // write to a common edge
    let result2 = await writeEdgeAsync(storage, keypair1, {
        appName: 'mygraph',
        source: 'aaa',
        kind: 'LIKED',
        dest: 'bbb',
        owner: 'common',
    }, 123);
    t.same(result2, WriteResult.Accepted, 'ok to wite with "common" owner from any keypair');
    for (let content of await storage.contents()) {
        t.same(JSON.parse(content).data, 123, 'data was written and round-tripped through JSON');
    }

    // overwrite a common edge with a different author
    let result3 = await writeEdgeAsync(storage, keypair2, {
        appName: 'mygraph',
        source: 'aaa',
        kind: 'LIKED',
        dest: 'bbb',
        owner: 'common',
    }, '2');
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

        // appName must be a valid part of an earthstar path
        // neither starting nor ending in a slash
        { shouldBeValid: true, graphQuery: { appName: 'blog' }},
        { shouldBeValid: true, graphQuery: { appName: 'blog/gardening' }},
        { shouldBeValid: false, graphQuery: { appName: '/blog' }},  // no leading slash
        { shouldBeValid: false, graphQuery: { appName: 'blog/' }},  // no leading slash
        { shouldBeValid: false, graphQuery: { appName: 'bl og' }},  // invalid in earthstar path

        // owner must be "common" or a full author address with no tilde
        { shouldBeValid: true, graphQuery: { owner: 'common'}},
        { shouldBeValid: true, graphQuery: { owner: author1}},
        { shouldBeValid: false, graphQuery: { owner: '~' + author1}},  // no tilde allowed
        { shouldBeValid: false, graphQuery: { owner: '@fooo'}},  // only shortname is not enough

        // kind must be valid as a single path segment in an earthstar path
        { shouldBeValid: true, graphQuery: { kind: 'foo'}},  // ok as a path segment
        { shouldBeValid: false, graphQuery: { kind: '/foo'}}, // not allowed as a parth segment
        { shouldBeValid: false, graphQuery: { kind: 'foo/'}}, // not allowed as a parth segment
        { shouldBeValid: false, graphQuery: { kind: '/'}},  // not allowed as a path segment
        { shouldBeValid: false, graphQuery: { kind: '*'}},  // not allowed as a path segment
        { shouldBeValid: false, graphQuery: { kind: '?'}},  // not allowed as a path segment
        { shouldBeValid: false, graphQuery: { kind: 'foo bar'}},  // not allowed as a path segment
    ];
    for (let { graphQuery, shouldBeValid } of vectors) {
        let err = validateGraphQuery(graphQuery);
        t.same(notErr(err), shouldBeValid, `should${shouldBeValid ? '' : ' not'} be valid: ${JSON.stringify(graphQuery)}`);
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
        expectedEdges: GraphEdgeContent[],
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
                Object.values(TEST_EDGES.edgesByAuthor2)).filter(e => {
                    return e.kind !== 'DELETED';
                }),
        },
    ];
   
    let err = findEdgesSync(storage, {owner: 'not-a-valid-owner'});
    t.true(err instanceof ValidationError, 'findEdges checks queries for validatione errors');
    let err2 = findEdgesSync(storage, {appName: '/////'});
    t.true(err2 instanceof ValidationError, 'findEdges checks queries for validatione errors');

    for (let { desc, graphQuery, extraQuery, expectedEdges } of testCases) {
        //log('-------------------- ' + desc);
        //log(JSON.stringify(graphQuery, null, 4));
        //log('  -->');

        let docs = findEdgesSync(storage, graphQuery, extraQuery);
        if (isErr(docs)) {
            t.fail(desc + ': findEdges failed with error: ' + docs);
            continue;
        }

        let actualEdges: (GraphEdgeContent | null)[] = [];
        // this returns deleted docs too, so we have to
        // carefully skip them when JSON parsing their content,
        // or the JSON.parse will crash on the empty content
        for (let doc of docs) {
            try {
                actualEdges.push(JSON.parse(doc.content) as GraphEdgeContent);
            } catch (err) {
            }
        }
        //log(actualEdges.map(edge => JSON.stringify(edge, null, 4)).join('\n'));
        t.same(new Set(actualEdges), new Set(expectedEdges), desc + ': edges should match');

    }

    storage.close()
    
    t.done();
})

// TODO: test findEdgesAsync
// TODO: test deletion
