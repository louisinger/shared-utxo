import { bip341, crypto } from 'liquidjs-lib';
import * as ecc from 'tiny-secp256k1';

export function sortedTaprootTree(
  leaves: bip341.TaprootLeaf[]
): bip341.HashTree {
  const sortedLeaves = [...leaves].sort((a, b) => {
    const aHash = bip341.tapLeafHash(a);
    const bHash = bip341.tapLeafHash(b);
    return aHash.compare(bHash);
  });
  return bip341.toHashTree(sortedLeaves, true);
}

export function taprootWitnessProgram(
  xOnlyInternalPubKey: Buffer,
  treeRootHash: Buffer
): Buffer {
  if (xOnlyInternalPubKey.length !== 32) {
    throw new Error('Internal pubkey must be 32 bytes long');
  }

  if (treeRootHash.length !== 32) {
    throw new Error('Tree root hash must be 32 bytes long');
  }

  const toTweak = Buffer.concat([xOnlyInternalPubKey, treeRootHash]);
  const tweakHash = crypto.taggedHash('TapTweak/elements', toTweak);
  const { xOnlyPubkey } = ecc.xOnlyPointAddTweak(
    xOnlyInternalPubKey,
    tweakHash
  );
  return Buffer.from(xOnlyPubkey);
}

const TAPROOT_NODE_SIZE = 32;
const TAPROOT_BASE_SIZE = 33;

export function computeMerkleRoot(
  control: Buffer,
  tapLeafHash: Buffer
): Buffer {
  const pathLen = (control.length - TAPROOT_BASE_SIZE) / TAPROOT_NODE_SIZE;

  let k = tapLeafHash;

  for (let i = 0; i < pathLen; i++) {
    const nodeHash = control.subarray(
      TAPROOT_BASE_SIZE + i * TAPROOT_NODE_SIZE,
      TAPROOT_BASE_SIZE + (i + 1) * TAPROOT_NODE_SIZE
    );

    if (k.compare(nodeHash) > 0) {
      k = tapBranchHash(nodeHash, k);
    } else {
      k = tapBranchHash(k, nodeHash);
    }
  }

  return k;
}

function tapBranchHash(r: Buffer, l: Buffer): Buffer {
  return crypto.taggedHash('TapBranch/elements', Buffer.concat([r, l]));
}
