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
    queryMatchesDoc,
    sha256base32,
} from 'earthstar';
import {
    EdgeContent,
    GRAPH_PATH_PREFIX,
    GraphQuery,
    _globToEarthstarQueryAndPathRegex,
    findEdges,
    findEdgesAsync,
    validateGraphQuery,
    writeEdge,
    _graphQueryToGlob,
} from '../index';

import t = require('tap');
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

let addTestData = async (storage: IStorage): Promise<void> => {

    // 1
    await writeEdge(storage, keypair1, {
        source: author1,
        kind: 'FOLLOWED',
        dest: author2,
        owner: author1,
    });

    // 2
    await writeEdge(storage, keypair1, {
        source: author1,
        kind: 'AUTHORED',
        dest: blogPath,
        owner: author1,
    });

    // 3
    await writeEdge(storage, keypair2, {
        source: author2,
        kind: 'LIKED',
        dest: blogPath,
        owner: author2,
    });

    // 4
    await writeEdge(storage, keypair2, {
        source: author2,
        kind: 'REACTED',
        dest: blogPath,
        owner: author2,
        data: { reaction: ':)' },
    });

    // 5
    await writeEdge(storage, keypair2, {
        source: author2,
        kind: 'AUTHORED',
        dest: commentPath,
        owner: author2,
    });

    // 6
    await writeEdge(storage, keypair2, {
        source: commentPath,
        kind: 'COMMENTS_ON',
        dest: blogPath,
        owner: author2,
    });

    // 7
    await writeEdge(storage, keypair1, {
        source: blogPath,
        kind: 'LINKED_TO',
        dest: externalUrl,
        owner: author1,
    });

    // 8 bidirectional link from both sides:
    await writeEdge(storage, keypair2, {
        source: wikiPath1,
        kind: 'LINKED_TO',
        dest: wikiPath2,
        owner: 'common',
    });

    // 9 bidirectional link from both sides:
    await writeEdge(storage, keypair2, {
        source: wikiPath2,
        kind: 'LINKED_TO',
        dest: wikiPath1,
        owner: 'common',
    });

    // 10 a single non-directed link
    let nodes = [author1, author2];
    nodes.sort();
    await writeEdge(storage, keypair1, {
        source: nodes[0],  // smaller first, for consistency
        kind: '-IS_SAME_PERSON_AS-',
        dest: nodes[1],
        owner: author1,
    });
}

//================================================================================

t.test('writeEdge: basics', async (t: any) => {
    let storage = new StorageMemory([ValidatorEs4], workspace);

    await addTestData(storage);
    let paths = await storage.paths();
    t.same(paths.length, 10, 'expected number of edges in test data; all were written successfully');

    storage.close();
    t.done();
});

t.test('writeEdge: keypair permissions', async (t: any) => {
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

t.test('validateGraphQuery', async (t: any) => {
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

t.test('_graphQueryToGlob', async (t: any) => {
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

t.test('_globToEarthstarQueryAndPathRegex', async (t: any) => {
    interface Vector {
        glob: string,
        esQuery: Query,
        pathRegex: string | null,
        matchingPaths: string[],
        nonMatchingPaths: string[],
    };
    let vectors: Vector[] = [
        {
            // if there's no asterisks...
            glob: '/a',
            esQuery: { path: '/a', contentLengthGt: 0, },  // exact path, not startsWith and endsWith
            pathRegex: null,  // no regex is needed
            matchingPaths: ['/a'],
            nonMatchingPaths: ['/', 'a', '/b', '-/a', '/a-'],
        },
        {
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

