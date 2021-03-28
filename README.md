# Earthstar Graph Db

This is a graph database stored in Earthstar.

## Edges

Each edge is stored as an Earthstar documents with a special path.  Each has a "kind", and can contain extra arbitrary user data which is stored in the document content.

Edges have owners for access control like any other Earthstar document, so they can be owned by one person only or writable by anyone ("common").

All edges are directed and have a source and destination node.  If you want to treat some edges as undirected, sort the source and dest and use the lower one as the source, for consistency.

Edges are all stored under a namespace for your app, to keep them separate from other apps.

Edge properties:
```ts
export interface GraphEdgeContent {
    appName: string,  // name of your app.  no leading slash or trailing slash.  internal slashes ok.
    source: string,  // we will hash this for you to make the path
    dest: string,  // we will hash this for you to make the path
    owner: AuthorAddress | 'common',  // author address should not include tilde
    kind: string,  // what flavor of edge is this?  what does it mean?
    data?: any;  // any user-provided data about this edge that can be JSON serialized
}
```

## Nodes

Any string can be used as a "node" address that the edges are connecting.  Usually you would use paths to other Earthstar documents as your node addresses, but you could also use author names, URLs, or anything else.  These node-strings can be arbitrarily long and can contain any special characters you want.

## Example use cases

This is not real notation, just made up for these diagrams:
```
node-source   --EDGE_KIND-->  node-dest
node-source   --EDGE_KIND { data: 'whatever' } -->  node-dest
```

Likes and comments on any Earthstar document:
```
@suzy.abcdefg  --LIKES-->   /blog/post/123.md
/comment/432.md  --COMMENTS_ON-->  /blog/post/123.md
```

Following, blocking, and web-of-trust:
```
@suzy.abcdefg  --FOLLOWS-->  @jose.lmnopqr
@suzy.abcdefg  --TRUSTS { trust: 0.33 }-->  @jose.lmnopqr
```

Store info about the links in a wiki.  You can then search these forwards or backwards (e.g. backlinks).  These edges would have to be created when the wiki pages were saved, or could be added by an indexer later.
```
/wiki/Kittens.md  --LINKS_TO-->  /wiki/Cats.md
```

Referencing external URLs:
```
@suzy.abcdefg  --HAS_OTHER_IDENTITY-->  http://twitter.com/suzy
```

Reaching across to other Earthstar workspaces. (Note this needs some thought because we should keep the other workspace address secret from people who don't know it already; it would probably be enough to just hash it).
```
@suzy.abcdefg  --IS_ALSO_IN_WORKSPACE-->  +sailing.ajofiajfo
@suzy.abcdefg  --LIKES-->  +sailing.ajofiajfo/blog/post/123.md
```

## How edges are stored

Each edge is an Earthstar document with a path like this:
```
path template:

/{appName}/graph/v1/edge/source:{sourceHash}/owner:{owner}/kind:{kind}/dest:{destHash}.json
```

We hash the source and dest strings to shorten them and remove punctuation that would interfere with the Earthstar path.

Each edge document's content is a `GraphEdgeContent` (see above) as a JSON string.

Edges that have been deleted have empty strings for their document content, as is usual in Earthstar.

## Querying with `findEdgesSync` and `findEdgesAsync`

You look up edges with GraphQuery objects.  This is similar to the `Query` type in core Earthstar, but it's just for edges.

```ts
// If the query is just {}, it returns every edge.
// All parameters are optional and will narrow down results further.
interface GraphQuery {
    appName?: string,
    source?: string,
    dest?: string,
    owner?: AuthorAddress | 'common',  // don't include tilde
    kind?: string,
}

// Example: Let's get everything that @suzy likes.
let myGraphQuery: GraphQuery = {
    source: '@suzy.aorifjaof',
    owner: '@suzy.aorifjaof',  // only read edges made by @suzy!
    kind: 'LIKES',
};

// do the query to find the edges
let matchingEdgeDocuments = findEdgesSync(
    myStorage,
    myGraphQuery,
    { contentLengthGt: 0 }  // extra query options; this skips deleted documents
);

// if you have an async storage, do this instead
// let matchingEdgeDocuments = await findEdgesAsync(..... etc .....);

// parse the edge documents' content to get the EdgeContent data
if (isErr(matchingEdgeDocuments)) { throw "oops"; }
for (let edgeDoc of matchingEdgeDocs) {
    // normally we have to be careful with this JSON.parse because
    // there might be deleted documents with content = '', but luckily
    // we excluded those from our query already
    let edgeContent: EdgeContent = JSON.parse(edgeDoc.content);
    console.log(`suzy likes ${edgeContent.dest}`);
}
```

## Writing with `writeEdgeSync` and `writeEdgeAsync`

Depending on if your storage is a synchronous or asynchronous storage.

```ts
let edge: GraphEdge = {
    appName: 'mygraph',
    source: author1,
    kind: 'FOLLOWED',
    dest: author2,
    owner: author1,
}

let result = await writeEdgeAsync(storage, keypair1, edge);

// (or to put data on the edge, which can be any JSON-serializable value:)
let result = await writeEdgeAsync(storage, keypair1, edge, 'my data goes here');

// check if the write succeeded
if (result !== WriteResult.Accepted) {
    console.error(result);
}
```

## Delete edges with `deleteEdgeSync` and `deleteEdgeAsync`

```ts
// overwrite with a blank document
let result = deleteEdgeSync(storage, authorKeypair, edge);

// check if the write succeeded
if (result !== WriteResult.Accepted) {
    console.error(result);
}
```

## TODO

* Make it easier to query for **nodes** that have certain edges.  You can do this now by just querying for the edges, then building a `Set<string>()` out of the `source` or `dest` fields.

## Out of scope

There will **not** be any fancy querying that has to traverse multiple edges to find matches -- it'll be too slow.  We're limited by the built-in querying power of Earthstar which doesn't have the indexes needed for something like that.

## Efficiency

Under the hood, all these queries are being translated into `pathStartsWith` and `pathEndsWith` Earthstar queries, which are not very powerful, so then we have to do an extra layer of regex filtering on the paths of the result documents.

Since our paths look like this...
```
/{appName}/graph/v1/edge/source:{sourceHash}/owner:{owner}/kind:{kind}/dest:{destHash}.json
```

The very fastest query will specify every variable -- then it's just a lookup, not a query, which is very fast.

Fast queries will have specific values for the outermost variables so we can take advantage of startsWith and endsWith, and will leave the inner variables unspecified.  For example, you should always specify the `appName` and either the `source` or `dest` if you can.

Slower queries will only specify variables in the middle, like `owner` or `kind` by themselves.  In those cases we can't do much with startsWith and endsWith and we have to scan through all the edges with a regex.
