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
        query: GraphQuery,
        shouldBeValid: boolean,
    };
    let vectors: Vector[] = [
        { shouldBeValid: true,  query: {}},

        { shouldBeValid: true,  query: { owner: 'common'}},
        { shouldBeValid: true,  query: { owner: author1}},
        { shouldBeValid: false, query: { owner: '~' + author1}},
        { shouldBeValid: false, query: { owner: '@fooo'}},

        { shouldBeValid: true,  query: { kind: 'foo'}},
        { shouldBeValid: false, query: { kind: '/'}},
        { shouldBeValid: false, query: { kind: '*'}},
        { shouldBeValid: false, query: { kind: '?'}},
        { shouldBeValid: false, query: { kind: 'foo bar'}},
    ];
    for (let { query, shouldBeValid } of vectors) {
        let err = validateGraphQuery(query);
        t.same(notErr(err), shouldBeValid, `should${shouldBeValid ? '' : ' not'} be valid: ${JSON.stringify(query)}`);
    }
    t.done();
});

t.test('_graphQueryToGlob', async (t: any) => {
    interface Vector {
        query: GraphQuery,
        glob: string,
    };
    let PATH_PREFIX
    let vectors: Vector[] = [
        { query: {}, glob: `${GRAPH_PATH_PREFIX}/source:*/owner:*/kind:*/dest:*.json` },
        { query: {owner: 'common'}, glob: `${GRAPH_PATH_PREFIX}/source:*/owner:common/kind:*/dest:*.json` },
        { query: {owner: author1}, glob: `${GRAPH_PATH_PREFIX}/source:*/owner:~${author1}/kind:*/dest:*.json` },
        { query: {kind: 'foo'}, glob: `${GRAPH_PATH_PREFIX}/source:*/owner:*/kind:foo/dest:*.json` },
        { query: {source: 'a'}, glob: `${GRAPH_PATH_PREFIX}/source:${sha256base32('a')}/owner:*/kind:*/dest:*.json` },
        { query: {dest: 'a'}, glob: `${GRAPH_PATH_PREFIX}/source:*/owner:*/kind:*/dest:${sha256base32('a')}.json` },
    ];
    for (let { query, glob } of vectors) {
        let returnedGlob = _graphQueryToGlob(query);
        t.same(returnedGlob, glob, `glob should match for query ${JSON.stringify(query)}`);
    }
    t.done();
});

t.skip('glob', async (t: any) => {
    interface Vector {
        glob: string,
        query: Query,
        regex: string | null,
        matchingPaths: string[],
        otherPaths: string[],
    };
    let vectors: Vector[] = [
        {
            glob: '/a',
            query: { path: '/a' },
            regex: null,
            matchingPaths: ['/a'],
            otherPaths: ['/', 'a', '/b', 'x/a', '/ax'],
        },
        {
            glob: '/a*b',
            query: { pathStartsWith: '/a', pathEndsWith: 'b' },
            regex: null,
            matchingPaths: '/ab /azzzb'.split(' '),
            otherPaths: '/a /b x/ab /abx'.split(' '),
        },
        {
            glob: '/a*b*c',
            query: { pathStartsWith: '/a', pathEndsWith: 'c' },
            regex: '^/a.*b.*c$',
            matchingPaths: [
                '/abc',
                '/abxxc',
                '/axxxbxxc',
            ],
            otherPaths: [
                '/acb',
                'x/abc',
                '/abcx',
                '/ac',
                '/axc',
            ],
        },
        {
            glob: '/a:*/b:*/c:*.json',
            query: { pathStartsWith: '/a:', pathEndsWith: '.json' },
            regex: '^/a:.*/b:.*/c:.*\\.json$',
            matchingPaths: [
                '/a:1/b:2/c:3.json',
                '/a:/b:/c:.json',
                '/a:1/b:2/x:99/c:3.json',
            ],
            otherPaths: [
                '/a:1/b:2/c:3xjson',
                '/a/b/c.json',
                '/a:/b/c:.json',
                '/a:xxxx.json',
                'x/a:1/b:2/c:3.jsonx',
            ],
        }
    ];

    for (let { glob, query, regex, matchingPaths, otherPaths } of vectors) {
        let result = _globToEarthstarQueryAndPathRegex(glob);
        console.log('---');
        console.log(JSON.stringify({
            glob: glob,
            result: result,
        }, null, 4));
        t.same(query, result.query, 'query is as expected: ' + glob);
        t.same(regex, result.pathRegex, 'regex is as expected: ' + glob);
        if (regex != null) {
            let re = new RegExp(regex);
            for (let match of matchingPaths) {
                t.true(re.test(match), 'regex should match: ' + match);
            }
            for (let nonMatch of otherPaths) {
                t.false(re.test(nonMatch), 'regex should not match: ' + nonMatch);
            }
        }
    }

    t.done();
});

