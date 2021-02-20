# Earthstar Graph Db

**In progress!**

This will be a graph database stored in Earthstar.

All edges are directional and have a built-in "kind" property as well as arbitrary user-settable data.

Nodes ("sources" and "destinations") will be arbitrary strings that will usually be Earthstar paths but could also be authors, external URLs, etc.

Edges are each stored as a single Earthstar document.

Edges will have owners for access control like any other Earthstar document, so they can be owned by one person only or writable by anyone.

## Example use cases

This is not real notation, just made up for these diagrams.

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

Find backlinks in a wiki.  (The edges would have to be created when the wiki pages were saved, or could be added by an indexer later):
```
/wiki/Kittens.md  --LINKS_TO-->  /wiki/Cats.md
```

Referencing external URLs:
```
@suzy.abcdefg  --HAS_OTHER_IDENTITY-->  http://twitter.com/suzy
```

Reaching across to other Earthstar workspaces:
```
@suzy.abcdefg  --IS_IN_WORKSPACE-->  +sailing.ajofiajfo
@suzy.abcdefg  --LIKES-->  +sailing.ajofiajfo/blog/post/123.md
```

## How edges are stored

Each edge is an Earthstar document with a path like (spaces added for readability):
```
/ graphdb-v1 / edge / source:SOURCE_HASH / owner:OWNER / kind:EDGE_KIND / dest:DEST_HASH.json
```

We hash the source and dest strings to shorten them and remove punctuation that would interfere with the Earthstar path.,

Each edge document holds this content:
```ts
interface EdgeContent {
    source: string,
    dest: string,
    kind: string,
    data?: any;  // any user-provided data about this edge
}
```

## Querying

You look up edges with GraphQuery objects.  This is similar to the `Query` type in core Earthstar, but it's just for edges.

```ts
// If the query is just {}, it returns every edge.
// All parameters are optional and will narrow down results further.
interface GraphQuery {
    source?: string,
    dest?: string,
    owner?: AuthorAddress | 'common',
    kind?: string,
}

// Specify the edges you want.
// Let's get everything that @suzy likes.
let myGraphQuery: GraphQuery = {
    source: '@suzy.aorifjaof',
    owner: '@suzy.aorifjaof',  // only read edges made by @suzy!
    kind: 'LIKES',
};

// do the query to find the edges
let matchingEdgeDocuments = findEdges(myStorage, myGraphQuery);

// parse the edge documents' content to get the EdgeContent data
for (let edgeDoc of matchingEdgeDocs) {
    let edgeContent: EdgeContent = JSON.parse(edgeDoc.content);
}
```

There will be a similar way to query for nodes that have certain edges.

There will probably **not** be any fancy querying that has to traverse multiple edges to find matches -- it'll be too slow.  We're limited by the built-in querying power of Earthstar which doesn't have the indexes needed for something like that.

## More details

Read the extensive comments in [index2.ts](https://github.com/earthstar-project/earthstar-graph-db/blob/main/src/index2.ts) for more details.