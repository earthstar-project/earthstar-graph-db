import {
    AuthorKeypair,
    IStorage,
    IStorageAsync,
    StorageMemory,
    ValidationError,
    ValidatorEs4,
    WriteResult,
    generateAuthorKeypair,
    isErr,
} from 'earthstar';
import {
    EdgeContent,
    GraphQuery,
    _transformGraphQuery,
    addEdge,
    findEdges,
    findEdgesAsync,
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
 
 8 /wiki/cats.md     common:LINKED_TO  /wiki/kittens.md
 9 /wiki/kittens.md  common:LINKED_TO  /wiki/cats.md

// TODO: a non-directed edge:

10 @onee   -IS_SAME_PERSON_AS-   @twoo

*/

let addTestData = async (storage: IStorage): Promise<void> => {
    let blogPath = '/blog/post/123.md';
    let commentPath = '/blog/comment/456.md';

    // 1
    await addEdge(storage, keypair1, {
        source: author1,
        kind: 'FOLLOWED',
        dest: author2,
        owner: author1,
    });

    // 2
    await addEdge(storage, keypair1, {
        source: author1,
        kind: 'AUTHORED',
        dest: blogPath,
        owner: author1,
    });

    // 3
    await addEdge(storage, keypair2, {
        source: author2,
        kind: 'LIKED',
        dest: blogPath,
        owner: author2,
    });
}

t.test('keypair permissions', async (t: any) => {
    let storage = new StorageMemory([ValidatorEs4], workspace);

    let result = await addEdge(storage, keypair1, {
        source: 'aaa',
        kind: 'LIKED',
        dest: 'bbb',
        owner: author2,  // does not match keypair1 above
    });
    t.true(result instanceof ValidationError, 'should not be able to do earthstar write with keypair 1 but edge owner 2 - should cause a ValidationError');

    // write to a common edge
    let result2 = await addEdge(storage, keypair1, {
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
    let result3 = await addEdge(storage, keypair2, {
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

t.test('basics', async (t: any) => {
    let storage = new StorageMemory([ValidatorEs4], workspace);

    await addTestData(storage);

    for (let d of await storage.documents()) {
        log(d);
    }

    storage.close();
    t.done();
});
