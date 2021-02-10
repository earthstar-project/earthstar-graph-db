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

export type EarthstarAppName = string;
export type NodeKind = string;
export type NodeOwner = AuthorAddress | 'common';
export type NodeName = string;
export type NodeExt = string;
export type NodePath = string;

export interface NodePointer {
    app: EarthstarAppName,  // no rules
    kind: NodeKind,  // no ':'
    owner: NodeOwner,  // no ':'
    name: NodeName,  // no ':' or '.'
    ext: NodeExt,  // no ':' or '.'
}

export let makeNodePath = (np: NodePointer): Path => {
    let owner: NodeOwner = 'common';
    if (np.owner.startsWith('@')) {
        owner = '~' + np.owner;
    }
    //                      |--- this part is called the "slug" ---|
    return `/${np.app}/node/${np.kind}:${owner}:${np.name}.${np.ext}`;
}

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




/*
interface Edgee {
    sourceNodeId: NodeId,
    destNodeId: NodeId,
    kind: EdgeKind,
}
*/

class EarthstarGraphDb {
    storage: IStorage;
    appName: string;
    constructor(storage: IStorage, appName: string,) {
        this.storage = storage;
        this.appName = appName;
    }

    /*
    saveNode(keypair: AuthorKeypair, node: Nodee, content: string): WriteResult | ValidationError {
        let path = makeNodePath(this.appName, node.kind, node.id);
        let docToSet: DocToSet = {
            format: 'es.4',
            path,
            content,
        }
        return this.storage.set(keypair, docToSet);
    }
    getNode(kind: NodeKind, id: NodeId): Document | undefined {
        let path = makeNodePath(this.appName, kind, id);
        let doc = this.storage.getDocument(path);
        return doc;
    }
    */

}



