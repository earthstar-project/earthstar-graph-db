import { isErr, ValidationError } from 'earthstar';
import t = require('tap');
import { makeNodePath, NodePointer, parseNodePath } from '..';
//t.runOnly = true;

//================================================================================

t.test('nodePointer <--> Path roundtrips', async (t: any) => {
    let np1: NodePointer = {
        app: 'music-v1',
        kind: 'artist',
        owner: 'common',
        name: 'four_tet',
        ext: 'json'
    }
    // roundtrips
    let path2 = makeNodePath(np1);
    let np3 = parseNodePath(path2);
    if (isErr(np3)) {
        t.fail('parseNodePath should not fail', np3);
        t.done();
        return;
    }
    let path4 = makeNodePath(np3);

    t.strictSame(path2, path4, 'paths should be same after roundtrip');
    t.strictSame(np1, np3, 'node pointers should be same after roundtrip');

    t.strictSame(path2, '/music-v1/node/artist:common:four_tet.json', 'path should be as expected');

    t.done();
});

t.test('parsing malformed paths', async (t: any) => {

    let testCases: [string, boolean][] = [
        ['/music-v1/node/artist:common:four_tet.json', true],
        ['/music-v1/node/artist:~@suzy.abcdefg:four_tet.json', true],

        ['', false],  // not enough path segments
        ['/', false],  // not enough path segments
        ['/music-v1/node', false], // not enough path segments
        ['/music-v1/node/artist:common:four_tet.json/a', false], // too many path segments
        ['/music-v1/nodeeee/artist:common:four_tet.json', false], // doesn't say "node"
        ['/music-v1/node/artist:common:four_tet:extra.json', false],  // extra part
        ['/music-v1/node/artist:common.json', false],  // missing part
        ['/music-v1/node/artist:banana:four_tet.json', false], // bad owner
        ['/music-v1/node/artist:~banana:four_tet.json', false], // bad owner
        ['/music-v1/node/artist:common:four_tetjson', false],  // no periods
        ['/music-v1/node/artist:common:four_tet.ok.json', false],  // too many periods
    ]

    for (let [path, shouldBeValid] of testCases) {
        let parsed = parseNodePath(path);
        if (shouldBeValid) {
            if (isErr(parsed)) { t.fail(`${path} should be valid but parsing returned an error`); }
            else { t.pass(`${path} is valid`);  }
        } else {
            if (isErr(parsed)) { t.pass(`${path} is invalid, as expected`); }
            else { t.fail(`${path} is valid but should not be`);  }
        }
    }

    t.done();
});
