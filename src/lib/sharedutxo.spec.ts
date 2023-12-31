import test from 'ava';
import { ECPairFactory } from 'ecpair';
import {
  bip341 as bip341LIB,
  BIP371SigningData,
  script as bscript,
  Creator,
  CreatorOutput,
  Extractor,
  Finalizer,
  networks,
  payments,
  Pset,
  Signer,
  Transaction,
  Updater,
} from 'liquidjs-lib';
import { OPS } from 'liquidjs-lib/src/ops';
import * as ecc from 'tiny-secp256k1';

import { broadcast, faucet, fetchTx, signTransaction } from './_regtest.spec';
import { extractSharedUtxo } from './script';
import {
  findLeafIncludingScript,
  sharedCoinTree,
  Stakeholder,
} from './sharedutxo';

const ECPair = ECPairFactory(ecc);
const bip341 = bip341LIB.BIP341Factory(ecc);

const LBTC = networks.regtest.assetHash;
const H_POINT = Buffer.from(
  '0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
  'hex'
);

const alice = ECPair.makeRandom();
const aliceP2WPKH = payments.p2wpkh({
  pubkey: alice.publicKey,
  network: networks.regtest,
});

const bob = ECPair.makeRandom();
const bobP2WPKH = payments.p2wpkh({
  pubkey: bob.publicKey,
  network: networks.regtest,
});

type Output = Transaction['outs'][0];
type Outpoint = { txid: string; vout: number };

let aliceUtxo: Output;
let aliceUtxoOutpoint: Outpoint;

let bobUtxo: Output;
let bobUtxoOutpoint: Outpoint;

test.before(async (t) => {
  const [aliceCoin, bobCoin] = await Promise.all([
    faucet(aliceP2WPKH.address),
    faucet(bobP2WPKH.address),
  ]);
  const [aliceTxHex, bobTxHex] = await Promise.all([
    fetchTx(aliceCoin.txid),
    fetchTx(bobCoin.txid),
  ]);

  const aliceTx = Transaction.fromHex(aliceTxHex);
  aliceUtxo = aliceTx.outs[aliceCoin.vout];
  aliceUtxoOutpoint = aliceCoin;

  const bobTx = Transaction.fromHex(bobTxHex);
  bobUtxo = bobTx.outs[bobCoin.vout];
  bobUtxoOutpoint = bobCoin;

  t.pass();
});

const checksig = (xOnlyPubKey: Buffer) => {
  if (xOnlyPubKey.length !== 32) {
    throw new Error('Internal pubkey must be 32 bytes long');
  }
  return bscript.compile([xOnlyPubKey, OPS.OP_CHECKSIG]);
};

// Alice and Bob have 1 LBTC each.
// They want to create a shared UTXO equals to 1.5 LBTC.
// Alice will put 1 LBTC and Bob 0.5 LBTC. Bob pays the miner fees.
test('shared utxo e2e test', async (t) => {
  const aliceStakeholder: Stakeholder = {
    leaves: [
      { scriptHex: checksig(alice.publicKey.subarray(1)).toString('hex') },
    ],
    amount: 1_0000_0000,
  };

  const bobStakeholder: Stakeholder = {
    leaves: [
      { scriptHex: checksig(bob.publicKey.subarray(1)).toString('hex') },
    ],
    amount: 1_0000_0000 / 2,
  };

  const stakeholders = [aliceStakeholder, bobStakeholder];

  // Alice and Bob share the amount provided in the shared coin and the tapscript locking it.
  // with the list of Stakeholder, they can create the taproot output script.
  const aliceBobTree = sharedCoinTree(stakeholders);
  const taprootOutputScript = bip341.taprootOutputScript(H_POINT, aliceBobTree);

  // then, Alice and Bob cooperate to send the coins to the shared coin script.

  const minerFeeAmount = 500;

  const pset = Creator.newPset({
    outputs: [
      new CreatorOutput(LBTC, 1_5000_0000, taprootOutputScript),
      new CreatorOutput(LBTC, 5000_0000 - minerFeeAmount, bobP2WPKH.output),
      new CreatorOutput(LBTC, minerFeeAmount),
    ],
  });

  const updater = new Updater(pset);
  updater.addInputs([
    {
      ...aliceUtxoOutpoint,
      txIndex: aliceUtxoOutpoint.vout,
      witnessUtxo: aliceUtxo,
      sighashType: Transaction.SIGHASH_ALL,
    },
    {
      ...bobUtxoOutpoint,
      txIndex: bobUtxoOutpoint.vout,
      witnessUtxo: bobUtxo,
      sighashType: Transaction.SIGHASH_ALL,
    },
  ]);

  const signed = signTransaction(
    updater.pset,
    [[alice], [bob]],
    Transaction.SIGHASH_ALL,
    ecc
  );

  const finalizer = new Finalizer(signed);
  finalizer.finalize();

  const tx = Extractor.extract(finalizer.pset);
  const txID = await broadcast(tx.toHex());
  console.info('sharing tx: ', tx.toHex());

  // Now, the coin { txID, vout: 0 } is a shared coin between Alice and Bob.
  // They can spend their part of the coin *independently without any cooperation*.

  // Alice wants to spend her part of the coin, going back to its original P2WPKH address.
  // To do this, she is forced by the covenant to push an additional change output with the bob coins as value.
  const aliceLeaf = findLeafIncludingScript(
    aliceBobTree,
    aliceStakeholder.leaves[0].scriptHex
  );

  const { taprootWitnessProgram, amount, outputIndex } = extractSharedUtxo(
    Buffer.from(aliceLeaf.scriptHex, 'hex')
  );
  t.is(amount, bobStakeholder.amount);
  t.is(outputIndex, 0);

  const changeScriptPubKey = Buffer.concat([
    Buffer.from([0x51, 0x20]),
    taprootWitnessProgram,
  ]);

  const alicePset = Creator.newPset({
    outputs: [
      new CreatorOutput(LBTC, bobStakeholder.amount, changeScriptPubKey),
      new CreatorOutput(
        LBTC,
        aliceStakeholder.amount - minerFeeAmount,
        aliceP2WPKH.output
      ),
      new CreatorOutput(LBTC, minerFeeAmount),
    ],
  });

  t.not(aliceLeaf, undefined);
  const aliceLeafHash = bip341LIB.tapLeafHash(aliceLeaf);
  const pathToAlice = bip341LIB.findScriptPath(aliceBobTree, aliceLeafHash);
  const [script, controlBlock] = bip341.taprootSignScriptStack(
    H_POINT,
    aliceLeaf,
    aliceBobTree.hash,
    pathToAlice
  );

  const aliceUpdater = new Updater(alicePset);
  aliceUpdater.addInputs([
    {
      txid: txID,
      txIndex: 0,
      witnessUtxo: tx.outs[0],
      sighashType: Transaction.SIGHASH_DEFAULT,
      tapInternalKey: H_POINT.subarray(1),
      tapLeafScript: {
        controlBlock,
        script,
        leafVersion: bip341LIB.LEAF_VERSION_TAPSCRIPT,
      },
    },
  ]);

  const preimage = aliceUpdater.pset.getInputPreimage(
    0,
    Transaction.SIGHASH_DEFAULT,
    networks.regtest.genesisBlockHash,
    aliceLeafHash
  );

  const signature = Buffer.from(
    ecc.signSchnorr(preimage, alice.privateKey, Buffer.alloc(32))
  );

  // then alice signs the transaction
  const aliceSignature: BIP371SigningData = {
    genesisBlockHash: networks.regtest.genesisBlockHash,
    tapScriptSigs: [
      {
        leafHash: aliceLeafHash,
        pubkey: alice.publicKey.subarray(1),
        signature,
      },
    ],
  };

  const signer = new Signer(aliceUpdater.pset);
  signer.addSignature(0, aliceSignature, Pset.SchnorrSigValidator(ecc));

  const aliceFinalizer = new Finalizer(signer.pset);
  aliceFinalizer.finalize();

  const aliceTx = Extractor.extract(aliceFinalizer.pset);
  console.log('\n');
  console.info('alice redeem: ', aliceTx.toHex());
  console.log('\n');

  const aliceTxID = await broadcast(aliceTx.toHex());

  // bob can spend the new shared coin without any cooperation from alice

  // first it needs to find the new script tree, as there is only 2 stakeholders here, it's easy
  const bobTree = sharedCoinTree([bobStakeholder]);
  const bobLeaf = findLeafIncludingScript(
    bobTree,
    bobStakeholder.leaves[0].scriptHex
  );
  const path = bip341LIB.findScriptPath(
    bobTree,
    bip341LIB.tapLeafHash(bobLeaf)
  );
  const [bobScript, bobControlBlock] = bip341.taprootSignScriptStack(
    H_POINT,
    bobLeaf,
    bobTree.hash,
    path
  );

  const bobPset = Creator.newPset({
    outputs: [
      new CreatorOutput(
        LBTC,
        bobStakeholder.amount - minerFeeAmount,
        bobP2WPKH.output
      ),
      new CreatorOutput(LBTC, minerFeeAmount),
    ],
  });

  const bobUpdater = new Updater(bobPset);
  bobUpdater.addInputs([
    {
      txid: aliceTxID,
      txIndex: 0,
      witnessUtxo: aliceTx.outs[0],
      sighashType: Transaction.SIGHASH_DEFAULT,
      tapInternalKey: H_POINT.subarray(1),
      tapLeafScript: {
        controlBlock: bobControlBlock,
        script: bobScript,
        leafVersion: bip341LIB.LEAF_VERSION_TAPSCRIPT,
      },
    },
  ]);

  const bobPreimage = bobUpdater.pset.getInputPreimage(
    0,
    Transaction.SIGHASH_DEFAULT,
    networks.regtest.genesisBlockHash,
    bip341LIB.tapLeafHash(bobLeaf)
  );

  const bobSignature = Buffer.from(
    ecc.signSchnorr(bobPreimage, bob.privateKey, Buffer.alloc(32))
  );

  const bobSignatureData: BIP371SigningData = {
    genesisBlockHash: networks.regtest.genesisBlockHash,
    tapScriptSigs: [
      {
        leafHash: bip341LIB.tapLeafHash(bobLeaf),
        pubkey: bob.publicKey.subarray(1),
        signature: bobSignature,
      },
    ],
  };

  const bobSigner = new Signer(bobUpdater.pset);
  bobSigner.addSignature(0, bobSignatureData, Pset.SchnorrSigValidator(ecc));

  const bobFinalizer = new Finalizer(bobSigner.pset);
  bobFinalizer.finalize();

  const bobTx = Extractor.extract(bobFinalizer.pset);
  console.info('bob redeem: ', bobTx.toHex());
  console.log('\n');

  await broadcast(bobTx.toHex());
  console.info('all the stakeholders has redeemed the shared coin');

  t.pass();
});
