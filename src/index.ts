
//================================================================================
//================================================================================
//================================================================================
//================================================================================
//
//      THIS FILE IS NOW DEPRECATED, SEE index2.ts FOR THE LATEST IDEA
//
//================================================================================
//================================================================================
//================================================================================
//================================================================================



import {
    AuthorAddress,
    AuthorKeypair,
    DocToSet,
    Document,
    IStorage,
    Path,
    ValidationError,
    WriteResult
} from 'earthstar';

//================================================================================

export type EarthstarAppName = string;
export type NodeKind = string;
export type NodeOwner = AuthorAddress | 'common';
export type NodeName = string;
export type NodeExt = string;
export type NodeSlug = string;

export interface NodePointer {
    app: EarthstarAppName,  // no rules
    kind: NodeKind,  // no ':'
    owner: NodeOwner,  // no ':'
    name: NodeName,  // no ':' or '.'
    ext: NodeExt,  // no ':' or '.'
}
export interface NodeWithDoc extends NodePointer {
    doc: Document,
}

interface NodeQuery {
    // these are in the same order they occur in the path.
    // you can supply these in any combination as long as the missing ones are in the middle
    // and the provided ones are at the start and/or the end.
    // e.g. there can only be one contiguous section of missing properties.

    app?: EarthstarAppName,  // no rules
    kind?: NodeKind,  // no ':'
    owner?: NodeOwner,  // no ':'
    name?: NodeName,  // no ':' or '.'
    ext?: NodeExt,  // no ':' or '.'

    // slug is different, it counts as a combination of kind, owner, name, ext.
    slug?: NodeSlug,
}

interface EdgeQuery {
    sourceNodeSlug?: string,
    kind?: string,
    destNodeSlug?: string,
}

/*
    nodes:
        /APPNAME/NODEKIND/OWNER/NAME.EXT

        /music-v1/artist/common/four_tet.json
        /music-v1/album/common/new_energy.json

        /social-v1/post/~@cinn.abcd/15000.md
        /social-v1/comment/~@suzy.abcd/15001.md

        built-in querying indexes:
            // latest time
            // author
            // is empty

        // sort by type, time -->
        // (to purely sort by time, do a query for each kind and merge them)
        // query by type & time range -->
        //                             <--- query by author
        /social-v1/post/15000.md/~@cinn.abcd
        /social-v1/comment/15001.md/~@suzy.abcd

        /chat-v1/message/channel:introductions/15000.txt/~@cinn.abcd

        /APP/NODEKIND/CHANNEL/SORTABLE_ID.EXT [/OWNER]

        queryies

        NODEKIND    CHANNEL     ID  EXT     OWNER

    edges:
        /APPNAME/(PATH1)/EDGE_OWNER/EDGEKIND/(PATH2)
        /APPNAME/(AUTHOR1)/EDGE_OWNER/EDGEKIND/(AUTHOR2)

        /graphdb-1/edge/(/social-v1/comment/@suzy.abcd/14001.md)/~@suzy.abcd/comment-is-about/(/social-v1/post/@cinn.abcd/15000.md)

        /graphdb-1/edge/(@cinn.abcd)/~@cinn.abcd/author-likes/(/social-v1/post/@cinn.abcd/15000.md)

        /graphdb-1/edge/(@cinn.abcd)/~@cinn.abcd/author-follows/(@suzy.abcd)

        /graphdb-1/edge/(/music-v1/artist/common/four_tet.json)/common/artist-has-album/(/music-v1/album/common/new_energy.json)

        fast queries:
            PATH1   OWNER   KIND    PATH2
            _____   _____   _____   given   { pathPrefix: '/graphdb-1/edge/(', pathSuffix: '/(PATH2)' }
            _____   _____   given   given
            _____   given   given   given
            given   _____   _____   _____
            given   _____   _____   given   { pathPrefix: '/graphdb-1/edge/(PATH1)/', pathSuffix: '/(PATH2)' }
            given   _____   given   given
            given   given   _____   _____   { pathPrefix: '/graphdb-1/edge/(PATH1)/OWNER/' }
            given   given   _____   given
            given   given   given   _____
            given   given   given   given

        slow queries:
            _____   _____   given   _____
            _____   given   _____   _____
            _____   given   given   _____   { pathPrefix: '/graphdb-1/edge/(', pathContains: ")/OWNER/EDGEKIND/(" }


        needed query capabilities
            pathPrefix
            pathSuffix
            pathContains

        nice to have
            pathGlob
*/

/*
interface Edgee {
    sourceNodeId: NodeId,
    destNodeId: NodeId,
    kind: EdgeKind,
}
*/

//================================================================================

export let makeNodeSlug = (np: NodePointer): NodeSlug => {
    let owner: NodeOwner = 'common';
    if (np.owner.startsWith('@')) {
        owner = '~' + np.owner;
    }
    return `${np.kind}:${owner}:${np.name}.${np.ext}`;
}

export let makeNodePath = (np: NodePointer): Path =>
    `/${np.app}/node/${makeNodeSlug(np)}`

export let parseNodePath = (path: string): NodePointer | ValidationError => {
    let segs = path.split('/');
    if (segs.length !== 4) { return new ValidationError('wrong number of path segments'); }
    let [_, app, n, slug] = segs;
    if (n !== 'node') { return new ValidationError('"node" not found in expected path segment'); }
    let parts = slug.split(':');
    if (parts.length !== 3) { return new ValidationError('wrong number of parts'); }
    let [kind, owner, nameExt] = parts;
    if (owner.startsWith('~@')) { owner = owner.slice(1); }
    else if (owner === 'common') { /* do nothing */ }
    else { return new ValidationError('bad owner'); }
    let nameParts = nameExt.split('.');
    // TODO: allow dots in name and only use the last one to separate the ext
    if (nameParts.length !== 2) { return new ValidationError('wrong number of name parts'); }
    let [name, ext] = nameParts;
    return {
        app,
        kind,
        owner,
        name,
        ext
    }
}


class EarthstarGraphDb {
    storage: IStorage;
    appName: string;
    constructor(storage: IStorage, appName: string,) {
        this.storage = storage;
        this.appName = appName;
    }

    saveNode(keypair: AuthorKeypair, np: NodePointer, content: string): WriteResult | ValidationError {
        let docToSet: DocToSet = {
            format: 'es.4',
            path: makeNodePath(np),
            content,
        }
        return this.storage.set(keypair, docToSet);
    }
    loadNodeDoc(np: NodePointer): NodeWithDoc | undefined {
        let doc = this.storage.getDocument(makeNodePath(np));
        if (doc === undefined) { return undefined; }
        return { ...np, doc };
    }

}



