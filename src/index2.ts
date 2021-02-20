import {
    AuthorAddress,
    AuthorKeypair,
    DocToSet,
    Document,
    IStorage,
    Path,
    Query,
    QueryForForget,
    ValidationError,
    WriteResult,
    documentIsExpired,
    sha256base32,
    ValidatorEs4,
    isErr,
    queryMatchesDoc,
    IStorageAsync,
} from 'earthstar';

//================================================================================

/*

A graph database.  Each edge is stored as a separate Earthstar document.
The "nodes" of the graph are any strings, usually Earthtar paths, but can also
be external URLs or author addresses.

All edges are directional.

If you want undirected edges, just sort your source and dest
so that the lowest is source and the highest is dest,
and query them with that in mind.

Each edge is stored at a path like this (spaces added for readibility).
This path is designed to be easily queried with pathStartsWith and pathEndsWith:

    /graphdb-v1 / edge / source:SOURCE_HASH / owner:OWNER / kind:EDGE_KIND / dest:DEST_HASH.json

Source and dest are typically Earthstar paths.
They appear in the edge's path as the sha256-base32 hash of the original strings
because we need to shorten them and remove weird punctuation.
They are also stored in full in the edge's Earthstar document.content.

OWNER is either "common" to allow any user to edit,
 or an author address with tilde, like ~@suzy.ajfoaifjaojf, to limit editing to that user.

KIND is the type for the edge, such as "likes" or "follows".

Each edge document is in JSON and holds the full unhashed versions of the source and dest,
and an optional `data` value for user data.

The combination of the 4 edge properties forms a primary key (source, owner, kind, dest)
and there can only be one edge with those 4 particular properties.
*/

//Path length calculations:
//    hashes are 53 characters long
//    author name plus ~ is 61 characters long
//    total path length = 214 + length of EDGE_KIND
//    The earthstar path length limit is 512 characters, so we have plenty of room


// You look up edges with GraphQuery objects.
// Specify each of these options to narrow down your query.
// If no options are set at all, this returns all edges in the workspace.
export interface GraphQuery {
    source?: string,
    dest?: string,
    owner?: AuthorAddress | 'common',
    kind?: string,
}

// This is stored in the Earthstar document.content for the edge.
export interface EdgeContent {
    source: string,
    dest: string,
    kind: string,
    data?: any;  // any user-provided data about this edge
}


// We're going to transform the graph query into an earthstar query,
//  along with an optional filter function to run on the results.

type FinalFilter = (path: Path) => boolean;
interface TransformedGraphQuery {
    esQuery: Query,
    finalFilter: null | FinalFilter,
}

export let _transformGraphQuery = (graphQuery: GraphQuery, extraEarthstarQuery?: Query): TransformedGraphQuery | ValidationError => {
    // Transform the graphQuery into an Earthstar query.
    // If extraEarthstarQuery is provided, it's mixed in too.  You can use it to provide
    //  extra constraints by timestamp, limit, etc.

    extraEarthstarQuery = extraEarthstarQuery === undefined ? {} : extraEarthstarQuery;

    // Skip edge docs with doc.content length of zero, because those are deleted docs.
    // Note that the provided extra query can override this if it wants to get deleted docs too,
    //  by setting contentLengthGt: -1
    if (extraEarthstarQuery.contentLengthGt === undefined) {
        extraEarthstarQuery.contentLengthGt = 0;
    }

    // replace undefined edge query keys with '*' because it's shorter to type than 'undefined' :)
    let source = graphQuery.source || '*'
    let owner = graphQuery.owner || '*'
    let kind = graphQuery.kind || '*'
    let dest = graphQuery.dest || '*'

    // Check validitiy of inputs
    // soruce and dest can be any strings

    // owner must be 'common' or a valid author address
    if (owner !== '*' && owner !== 'common') {
        let parsedAuthor = ValidatorEs4.parseAuthorAddress(owner);
        if (isErr(parsedAuthor)) {
            return new ValidationError('if set, graphQuery.owner must be "common" or an author address like "@suzy.jawofiaj...."');
        }
    }
    // kind must be a valid earthstar path segment
    if (kind !== '*') {
        if (kind.indexOf('/') !== -1) {
            return new ValidationError(`edge kind "${kind}" must not contain a slash`);
        }
        let kindIsValid = ValidatorEs4._checkPathIsValid('/' + kind);
        if (isErr(kindIsValid)) {
            return new ValidationError(`edge kind "${kind}" is not valid in an earthstar path`);
        }
    }

    // hash the source and dest paths
    let sourceHash = source === '*' ? '*' : sha256base32(source);
    let destHash = dest === '*' ? '*' : sha256base32(dest);

    // make an array of the path parts we're going to assemble into our edge path, in the right order
    let parts = [sourceHash, owner, kind, destHash];
    // make a shorthand array where '-' represents known, and '*' represents not specified.
    // we'll use this to more easily pattern-match in the next section
    let partsPattern = parts.map(x => x === '*' ? '*' : '-').join();

    let esQuery: Query = {};
    let basePrefix: string = '/graphdb-v1/edge'

    // Some combinations can't be done just with pathStartsWith and pathEndsWith.
    // These require an extra filtering step at the end.
    // They will provide a filter function which runs on each matched edge document,
    //  returning true on the ones they want to keep.
    // Queries that have to do this are slow - they are scanning every
    //  edge document in the whole workspace.
    let finalFilter: FinalFilter | null = null;

    // Build an earthstar query out of our 16 combinations of constraints.
    if (partsPattern === '----') {  // 0
        // everything is specified so we can just do a direct path query.
        // "get the one edge from source to dest, with given owner and kind"
        // this is fast!
        esQuery = {
            path: `${basePrefix}/source:${sourceHash}/owner:${owner}/kind:${kind}/destPath:${destHash}.json`
        }
    } else if (partsPattern === '---*') {  // 1
        // dest is not specified
        // "get all outgoing nodes from a path, with given owner and kind"
        esQuery = {
            pathStartsWith: `${basePrefix}/source:${sourceHash}/owner:${owner}/kind:${kind}/`,
            pathEndsWith: `.json`,
        }
    } else if (partsPattern === '--*-') {  // 2
        // kind is not specified
        // get all edges between source and dest, with the given owner"
        esQuery = {
            pathStartsWith: `${basePrefix}/source:${sourceHash}/owner:${owner}/`,
            pathEndsWith: `/${destHash}.json`,
        }
    } else if (partsPattern === '--**') {  // 3
        // kind, dest is not specified
        // "get all outgoing nodes from a path, with given owner and any kind"
        esQuery = {
            pathStartsWith: `${basePrefix}/source:${sourceHash}/owner:${owner}/`,
            pathEndsWith: `.json`,
        }
    } else if (partsPattern === '-*--') {  // 4
        // owner is not specified
        // "get all edges between source and dest, with any owner, for the given kind"
        esQuery = {
            pathStartsWith: `${basePrefix}/source:${sourceHash}/`,
            pathEndsWith: `/kind:${kind}/${destHash}.json`,
        }
    } else if (partsPattern === '-*-*') {  // 5
        // source and kind are specified
        // owner and dest are not
        // "get all outgoing edges from source node, of a certain kind"
        // this is slow
        esQuery = {
            pathStartsWith: `${basePrefix}/source:${sourceHash}/`,
            pathEndsWith: `.json`,
        }
        finalFilter = (path) =>
            path.indexOf('/kind:${}/') !== -1
    } else if (partsPattern === '-**-') {  // 6
        // source and dest are specified
        // owner and kind are not
        // "get all edges between source and dest"
        esQuery = {
            pathStartsWith: `${basePrefix}/source:${sourceHash}/`,
            pathEndsWith: `/dest:${destHash}.json`,
        }
    } else if (partsPattern === '-***') {  // 7
        // only source is specified
        // "get all outgoing edges from a path"
        esQuery = {
            pathStartsWith: `${basePrefix}/source:${sourceHash}/`,
            pathEndsWith: `.json`,
        }
    } else if (partsPattern === '*---') {  // 8
        return new ValidationError('TODO: combination #8 of edge query options is not implemented yet');
    } else if (partsPattern === '*--*') {  // 9
        return new ValidationError('TODO: combination #9 of edge query options is not implemented yet');
    } else if (partsPattern === '*-*-') {  // 10
        return new ValidationError('TODO: combination #10 of edge query options is not implemented yet');
    } else if (partsPattern === '*-**') {  // 11
        return new ValidationError('TODO: combination #11 of edge query options is not implemented yet');
    } else if (partsPattern === '**--') {  // 12
        return new ValidationError('TODO: combination #12 of edge query options is not implemented yet');
    } else if (partsPattern === '**-*') {  // 13
        return new ValidationError('TODO: combination #13 of edge query options is not implemented yet');
    } else if (partsPattern === '***-') {  // 14
        return new ValidationError('TODO: combination #14 of edge query options is not implemented yet');
    } else if (partsPattern === '****') {  // 15
        // no constraints at all, empty graph query.
        // "get all edges"
        esQuery = {
            pathStartsWith: `${basePrefix}/`,
            pathEndsWith: `.json`,
        }
    } else {
        return new ValidationError(`unexpected error: partsPattern = ${partsPattern}`);
    }

    // mix in the extra query
    esQuery = {
        ...extraEarthstarQuery,
        esQuery,
    } as Query;

    return {
        esQuery,
        finalFilter,
    }
}

//================================================================================
// Run a graph query on a storage.
// This will return an array of documents; you will need to 
// parse their document.content as JSON to get an EdgeContent object
// in order to read the original source and dest, kind, owner, and user-provided data.
// See the EdgeContent type, above.

// TODO: maybe parse it for you?  but you might also want the original document content like timestamp, ...

export let findEdges = (storage: IStorage, graphQuery: GraphQuery, extraEarthstarQuery?: Query): Document[] | ValidationError => {
    let transformed = _transformGraphQuery(graphQuery, extraEarthstarQuery);
    if (isErr(transformed)) { return transformed; }
    let { esQuery, finalFilter } = transformed;
    let docs = storage.documents(esQuery);
    if (finalFilter !== null) {
        docs = docs.filter(doc => (finalFilter as FinalFilter)(doc.path));
    }
    return docs;
}

export let findEdgesAsync = async (storage: IStorage | IStorageAsync, graphQuery: GraphQuery, extraEarthstarQuery?: Query): Promise<Document[] | ValidationError> => {
    let transformed = _transformGraphQuery(graphQuery, extraEarthstarQuery);
    if (isErr(transformed)) { return transformed; }
    let { esQuery, finalFilter } = transformed;
    let docs = await storage.documents(esQuery);
    if (finalFilter !== null) {
        docs = docs.filter(doc => (finalFilter as FinalFilter)(doc.path));
    }
    return docs;
}


//================================================================================

// TODO: functions for writing edges

