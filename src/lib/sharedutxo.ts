import { bip341, script } from 'liquidjs-lib';

import { mustHaveChangeOutput } from './script';
import { sortedTaprootTree, taprootWitnessProgram } from './taproot';

export type Stakeholder = {
  tapscript: Buffer;
  amount: number;
};

// unspendable x-only pubkey
const X_H_POINT = Buffer.from(
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
  'hex'
);

/**
 * Given a list of stakeholders, it creates a dynamic shared coin taproot tree.
 * @param stakeholders - the list of stakeholders owning the coin
 * @param internalPubKey - the internal pubkey used to create the tree (default: unspendable x-only pubkey)
 * @returns - bip341.HashTree with script hex
 */
export function sharedCoinTree(
  stakeholders: Stakeholder[],
  internalPubKey = X_H_POINT
): bip341.HashTree {
  if (stakeholders.length === 1) {
    const leaf = {
      scriptHex: stakeholders[0].tapscript.toString('hex'),
    };
    return bip341.toHashTree([leaf], true);
  }

  if (stakeholders.length > 1) {
    const sharedAmount = stakeholders.reduce((acc, s) => acc + s.amount, 0);
    const leaves = [];

    for (const [index, stakeholder] of stakeholders.entries()) {
      const stakeHoldersWithoutCurrent = stakeholders.filter(
        (_, i) => i !== index
      );

      const changeTree = sharedCoinTree(
        stakeHoldersWithoutCurrent,
        internalPubKey
      );

      const changeWitnessProgram = taprootWitnessProgram(
        internalPubKey,
        changeTree.hash
      );

      console.info(
        'changeWitnessProgram',
        changeWitnessProgram.toString('hex')
      );

      const scriptStack = script.decompile(stakeholder.tapscript);
      const leafScript = script.compile([
        // add a "script prefix" to the stakeholder tapscript forcing him to add output #0 with
        //   - scriptPubKey = segwit v1 + changeWitnessProgram
        //   - amount = sharedAmount - stakeholder.amount (the "new" shared amount after the stakeholder has spent his part)
        ...mustHaveChangeOutput(
          0,
          changeWitnessProgram,
          sharedAmount - stakeholder.amount
        ),
        ...scriptStack,
      ]);

      leaves.push({
        scriptHex: leafScript.toString('hex'),
      });
    }

    return sortedTaprootTree(leaves);
  }

  throw new Error('No stakeholders provided');
}

export function findLeafIncludingScript(
  tree: bip341.HashTree,
  scriptHex: string
): bip341.TaprootLeaf | undefined {
  if (tree.left) {
    const leftLeaf = findLeafIncludingScript(tree.left, scriptHex);
    if (leftLeaf) {
      return leftLeaf;
    }
  }

  if (tree.right) {
    return findLeafIncludingScript(tree.right, scriptHex);
  }

  if (tree.scriptHex) {
    return tree.scriptHex.includes(scriptHex)
      ? {
          scriptHex: tree.scriptHex,
        }
      : undefined;
  }

  return undefined;
}
