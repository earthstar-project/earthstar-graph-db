import {
    AuthorAddress,
    AuthorKeypair,
    DocToSet,
    Document,
    IStorage,
    IStorageAsync,
    Path,
    Query,
    QueryForForget,
    ValidationError,
    ValidatorEs4,
    WriteResult,
    documentIsExpired,
    isErr,
    queryMatchesDoc,
    sha256base32,
    validateQuery,
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

export const GRAPH_PATH_PREFIX: string = '/graphdb-v1/edge'

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
    owner: string,
    kind: string,
    data?: any;  // any user-provided data about this edge
}

//================================================================================
// NEW STUFF

let escapeRegExp = (s: string) => {
    // escape a string so it's safe to use in a regular expression
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

export let validateGraphQuery = (graphQuery: GraphQuery): ValidationError | null => {
    // Check validitiy of inputs
    // source and dest can be any strings

    let { source, dest, owner, kind } = graphQuery;

    // owner must be 'common' or a valid author address
    if (owner !== undefined && owner !== 'common') {
        let parsedAuthor = ValidatorEs4.parseAuthorAddress(owner);
        if (isErr(parsedAuthor)) {
            return new ValidationError('if set, graphQuery.owner must be "common" or an author address like "@suzy.jawofiaj...."');
        }
    }
    // kind must be a valid earthstar path segment
    if (kind !== undefined) {
        if (kind.indexOf('/') !== -1) {
            return new ValidationError(`edge kind "${kind}" must not contain a slash`);
        }
        let kindIsValid = ValidatorEs4._checkPathIsValid('/' + kind);
        if (isErr(kindIsValid)) {
            return new ValidationError(`edge kind "${kind}" is not valid in an earthstar path`);
        }
    }

    return null;
}

export let _graphQueryToGlob = (graphQuery: GraphQuery): string => {
    let source = graphQuery.source ?? '*'
    let owner = graphQuery.owner ?? '*'
    if (owner.startsWith('@')) { owner = '~' + owner; }
    let kind = graphQuery.kind ?? '*'
    let dest = graphQuery.dest ?? '*'

    let sourceHash = source === '*' ? '*' : sha256base32(source);
    let destHash = dest === '*' ? '*' : sha256base32(dest);

    let glob = `${GRAPH_PATH_PREFIX}/source:${sourceHash}/owner:${owner}/kind:${kind}/dest:${destHash}.json`

    return glob;
}

export let _globToEarthstarQueryAndPathRegex = (glob: string): { query: Query, pathRegex: string | null } => {
    // Given a glob string, return:
    //    - an earthstar Query
    //    - and a regular expression (as a plain string, not a RegExp instance).
    // After this you can run the query yourself and apply the regex
    // as a filter to the paths of the resulting documents,
    // to get only the documents whose paths match the glob.
    // The regex will be null if it's not needed.
    // The glob string only supports '*' as a wildcard, no other
    // special wildcards like '?' or '**' as in Bash.

    let parts = glob.split('*');
    let query: Query = { contentLengthGt: 0 };  // skip deleted edges
    let pathRegex = null;

    if (parts.length === 1) {
        query = {
            ...query,
            path: glob
        };
    } else {
        query = {
            ...query,
            pathStartsWith: parts[0],
            pathEndsWith: parts[parts.length - 1],
        };
        pathRegex = '^' + parts.map(escapeRegExp).join('.*') + '$';
    }

    return { query, pathRegex };
}


//================================================================================
// Run a graph query on a storage.
// This will return an array of documents; you will need to 
// parse their document.content as JSON to get an EdgeContent object
// in order to read the original source and dest, kind, owner, and user-provided data.
// See the EdgeContent type, above.

export let findEdges = (storage: IStorage, graphQuery: GraphQuery, extraEarthstarQuery?: Query): Document[] | ValidationError => {
    let err = validateGraphQuery(graphQuery);
    if (isErr(err)) { return err; }

    let glob = _graphQueryToGlob(graphQuery);
    let { query, pathRegex } = _globToEarthstarQueryAndPathRegex(glob);

    let docs = storage.documents(query);
    if (pathRegex != null) {
        let re = new RegExp(pathRegex);
        docs = docs.filter(doc => re.test(doc.path));
    }
    return docs;
}

// same as above but async
export let findEdgesAsync = async (storage: IStorage | IStorageAsync, graphQuery: GraphQuery, extraEarthstarQuery?: Query): Promise<Document[] | ValidationError> => {
    let err = validateGraphQuery(graphQuery);
    if (isErr(err)) { return err; }

    let glob = _graphQueryToGlob(graphQuery);
    let { query, pathRegex } = _globToEarthstarQueryAndPathRegex(glob);

    let docs = await storage.documents(query);
    if (pathRegex != null) {
        let re = new RegExp(pathRegex);
        docs = docs.filter(doc => re.test(doc.path));
    }
    return docs;
}

//================================================================================
// WRITING EDGES

// create or overwrite an edge.
export let writeEdge = async (storage: IStorage | IStorageAsync, authorKeypair: AuthorKeypair, edge: EdgeContent): Promise<ValidationError | WriteResult> => {
    let sourceHash = sha256base32(edge.source);
    let destHash = sha256base32(edge.dest);
    let ownerWithTilde = edge.owner === 'common' ? 'common' : '~' + edge.owner;
    let path = `${GRAPH_PATH_PREFIX}/source:${sourceHash}/owner:${ownerWithTilde}/kind:${edge.kind}/dest:${destHash}.json`
    let docToSet: DocToSet = {
        format: 'es.4',
        path: path,
        content: JSON.stringify(edge),
    };
    let setResult = await storage.set(authorKeypair, docToSet);
    //if (setResult !== WriteResult.Accepted) {
    //    console.warn(setResult);
    //}
    return setResult;
}

// TODO: deleteEdge
