import {
    AuthorAddress,
    AuthorKeypair,
    Document,
    IStorage,
    IStorageAsync,
    Query,
    ValidationError,
    ValidatorEs4,
    WriteResult,
    insertVariablesIntoTemplate,
    isErr,
    queryByTemplateAsync,
    queryByTemplateSync,
    sha256base32,
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

//================================================================================
// TYPES

// You look up edges with GraphQuery objects.
// Specify each of these options to narrow down your query.
// If no options are set at all, this returns all edges in the workspace.

/*
 * A GraphEdge completely specifies all the properties of an edge,
 *  except for its user-provided data content.
 */
export interface GraphEdge {
    appName: string,  // name of your app.  no leading slash or trailing slash.  internal slashes ok.
    source: string,  // we will hash this for you to make the path
    dest: string,  // we will hash this for you to make the path
    owner: AuthorAddress | 'common',  // author address should not include tilde
    kind: string,  // what flavor of edge is this?  what does it mean?
}

/*
 * A GraphQuery is a subset of a GraphEdge -- just the properties you want to
 * specify in a search.  The ones you leave out will turn into '*' wildcards
 * in the search.
 */
export type GraphQuery = Partial<GraphEdge>;

/*
 * EdgeContent is a GraphEdge plus its optional user-provided data content.
 * This is what's stored in the actual document content for the edge.
 * There's a bit of redundancy between this content and the path itself,
 *  but there are differences too (this stores source and dest, and the
 *  path stores sourceHash and destHash).
 */
export interface GraphEdgeContent extends GraphEdge {
    // everything from GraphEdge, plus:
    data?: any;  // any user-provided data about this edge that can be JSON serialized
}

/*
 * The variables used to construct an Earthstar path for an edge.
 * Similar to a GraphEdge, but with hashed versions of source and dest.
 */
export interface GraphEdgeTempalateVars {
    appName: string,
    sourceHash: string,
    owner: string,
    kind: string,
    destHash: string,
}

/*
 * The path template that's used for every edge document.
 */
const GRAPH_PATH_TEMPLATE = '/{appName}/graphdb/v1/edge/source:{sourceHash}/owner:{owner}/kind:{kind}/dest:{destHash}.json';

/*
 * Missing properties in a graph query get filled in with these defaults.
 */
const DEFAULT_GRAPH_QUERY: GraphQuery = {
    appName: '*',
    source: '*',
    owner: '*',
    kind: '*',
    dest: '*'
}

//================================================================================

export let validateGraphQuery = (graphQuery: GraphQuery): ValidationError | null => {
    // Make sure the query contains valid values.

    // source and dest can be any strings, since we hash them later.
    let { appName, owner, kind } = graphQuery;

    if (appName !== undefined) {
        if (appName.startsWith('/')) {
            return new ValidationError(`appName "${appName}" should not start with a slash`);
        }
        if (appName.endsWith('/')) {
            return new ValidationError(`appName "${appName}" should not end with a slash`);
        }
        let appNameIsValidInPath = ValidatorEs4._checkPathIsValid('/' + appName);
        if (isErr(appNameIsValidInPath)) {
            return new ValidationError(`appName "${appName}" is not valid in an Earthstar path`);
        }
    }

    // owner must be 'common' or a valid author address not starting with '~'
    if (owner !== undefined && owner !== 'common') {
        let parsedAuthor = ValidatorEs4.parseAuthorAddress(owner);
        if (isErr(parsedAuthor)) {
            return new ValidationError('if set, graphQuery.owner must be "common" or an author address like "@suzy.jawofiaj...." with no tilde');
        }
    }

    // kind must be a valid earthstar path segment
    if (kind !== undefined) {
        if (kind.indexOf('/') !== -1) {
            return new ValidationError(`edge kind "${kind}" must not contain a slash`);
        }
        let kindIsValid = ValidatorEs4._checkPathIsValid('/' + kind);
        if (isErr(kindIsValid)) {
            return new ValidationError(`edge kind "${kind}" is not valid as an earthstar path segment`);
        }
    }

    return null;
}

/*
 * Given a graph query, convert it to template vars to plug into the GRAPH_PATH_TEMPLATE.
 * This is where hashing of source and dest happens.
 */
export let _graphQueryToTemplateVars = (query: GraphQuery): GraphEdgeTempalateVars => {
    let fullQuery: GraphEdge = { ...DEFAULT_GRAPH_QUERY, ...query } as GraphEdge;
    let { appName, source, owner, kind, dest } = fullQuery;

    return {
        appName,
        sourceHash: source === '*' ? '*' : sha256base32(source as string),
        owner: owner.startsWith('@') ? '~' + owner : owner,
        kind,
        destHash: dest === '*' ? '*' : sha256base32(dest as string),
    };
};

//================================================================================
// QUERYING

/*
 * Run a graph query on a storage.
 * This will return an array of documents; you will need to 
 *  parse their document.content as JSON to get a GraphEdgeContent object
 *  in order to read the original source and dest, kind, owner, and user-provided data if it's there.
 * extraEarthstarQuery gets mixed in after the graphQuery and overrides it -- you probably don't
 *  want to override the path, pathStartsWith, or pathEndsWith values, but anything else is ok to override.
 * For example, to skip deleted edges set extraEarthstarQuery to { contentLenghtGt: 0 }.
 */
export let findEdgesSync = (storage: IStorage, graphQuery: GraphQuery, extraEarthstarQuery: Query = {}): Document[] | ValidationError => {
    let err = validateGraphQuery(graphQuery);
    if (isErr(err)) { return err; }

    // inject the vars and stars into the template.
    // every variable in the template will get replaced with a value or a star.
    let templateVars = _graphQueryToTemplateVars(graphQuery);
    let templateForSearching = insertVariablesIntoTemplate(templateVars as any, GRAPH_PATH_TEMPLATE);

    return queryByTemplateSync(storage, templateForSearching, extraEarthstarQuery);
}

/*
 * Async version of findEdges
 */
/* istanbul ignore next */
export let findEdgesAsync = async (storage: IStorage | IStorageAsync, graphQuery: GraphQuery, extraEarthstarQuery: Query = {}): Promise<Document[] | ValidationError> => {
    let err = validateGraphQuery(graphQuery);
    if (isErr(err)) { return err; }

    // inject the vars and stars into the template.
    // every variable in the template will get replaced with a value or a star.
    let templateVars = _graphQueryToTemplateVars(graphQuery);
    let templateForSearching = insertVariablesIntoTemplate(templateVars as any, GRAPH_PATH_TEMPLATE);

    return await queryByTemplateAsync(storage, templateForSearching, extraEarthstarQuery);
}

//================================================================================
// WRITING EDGES

/*
 * Create or overwrite an edge.
 * data is optional and should be any JSON-serializable data that will be stored along
 *  with the edge content.
 */
/* istanbul ignore next */
export let writeEdgeSync = (storage: IStorage, authorKeypair: AuthorKeypair, edge: GraphEdge, data?: any): ValidationError | WriteResult => {
    // edge is a GraphEdge, not a GraphQuery, so it has every field present.
    // every variable in the template will get replaced with a value, no stars or {var}s will be left.
    let templateVars = _graphQueryToTemplateVars(edge);
    let path = insertVariablesIntoTemplate(templateVars as any, GRAPH_PATH_TEMPLATE);

    let content: GraphEdgeContent = edge;
    if (data !== undefined) { content.data = data; }

    let setResult = storage.set(authorKeypair, {
        format: 'es.4',
        path,
        content: JSON.stringify(content),
    });
    //if (setResult !== WriteResult.Accepted) {
    //    console.warn(setResult);
    //}
    return setResult;
}

/*
 * Async version of writeEdge.
 */
export let writeEdgeAsync = async (storage: IStorage | IStorageAsync, authorKeypair: AuthorKeypair, edge: GraphEdge, data?: any): Promise<ValidationError | WriteResult> => {
    // edge is a GraphEdge, not a GraphQuery, so it has every field present.
    // every variable in the template will get replaced with a value, no stars or {var}s will be left.
    let templateVars = _graphQueryToTemplateVars(edge);
    let path = insertVariablesIntoTemplate(templateVars as any, GRAPH_PATH_TEMPLATE);

    let content: GraphEdgeContent = edge;
    if (data !== undefined) { content.data = data; }

    let setResult = storage.set(authorKeypair, {
        format: 'es.4',
        path,
        content: JSON.stringify(content),
    });
    //if (setResult !== WriteResult.Accepted) {
    //    console.warn(setResult);
    //}
    return setResult;
}

/*
 * Delete an edge by overwriting it with a blank document
 */
/* istanbul ignore next */
export let deleteEdgeSync = (storage: IStorage, authorKeypair: AuthorKeypair, edge: GraphEdge): ValidationError | WriteResult => {
    // edge is a GraphEdge, not a GraphQuery, so it has every field present.
    // every variable in the template will get replaced with a value, no stars or {var}s will be left.
    let templateVars = _graphQueryToTemplateVars(edge);
    let path = insertVariablesIntoTemplate(templateVars as any, GRAPH_PATH_TEMPLATE);
    let setResult = storage.set(authorKeypair, {
        format: 'es.4',
        path,
        content: '',
    });
    //if (setResult !== WriteResult.Accepted) {
    //    console.warn(setResult);
    //}
    return setResult;
};

/*
 * Async version of deleteEdge.
 */
export let deleteEdgeAsync = async (storage: IStorage | IStorageAsync, authorKeypair: AuthorKeypair, edge: GraphEdge): Promise<ValidationError | WriteResult> => {
    // edge is a GraphEdge, not a GraphQuery, so it has every field present.
    // every variable in the template will get replaced with a value, no stars or {var}s will be left.
    let templateVars = _graphQueryToTemplateVars(edge);
    let path = insertVariablesIntoTemplate(templateVars as any, GRAPH_PATH_TEMPLATE);
    let setResult = await storage.set(authorKeypair, {
        format: 'es.4',
        path,
        content: '',
    });
    //if (setResult !== WriteResult.Accepted) {
    //    console.warn(setResult);
    //}
    return setResult;
};
