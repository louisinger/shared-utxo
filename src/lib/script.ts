import { script as bscript } from 'liquidjs-lib';
import { BufferReader, BufferWriter } from 'liquidjs-lib/src/bufferutils';
import { OPS } from 'liquidjs-lib/src/ops';

export function mustHaveChangeOutput(
  outputIndex: number,
  taprootWitnessProgram: Buffer,
  amount: number
): (Buffer | number)[] {
  const index = outputIndex
    ? bscript.number.encode(outputIndex)
    : Buffer.alloc(0); // minimal encoding
  const amountBuffer = BufferWriter.withCapacity(8);
  amountBuffer.writeInt32(amount);

  return [
    // 1. check the script
    index,
    OPS.OP_INSPECTOUTPUTSCRIPTPUBKEY,
    OPS.OP_1,
    OPS.OP_EQUALVERIFY, // check that the output is a taproot script
    taprootWitnessProgram,
    OPS.OP_EQUALVERIFY, // check that the taproot witness program matches the one we expect

    // 2. check the amount
    index,
    OPS.OP_INSPECTOUTPUTVALUE,
    OPS.OP_1,
    OPS.OP_EQUALVERIFY, // check that the value is unconfidential
    amountBuffer.buffer,
    OPS.OP_EQUALVERIFY, // check that the amount matches the one we expect
  ];
}

export type ExtractSharedUtxoResult = {
  outputIndex: number;
  taprootWitnessProgram: Buffer;
  amount: number;
};

/**
 * Take a tapscript wrapped into shared output and extract the shared utxo data
 * @param script shared utxo script or not
 * @returns [isSharedUtxo, outputIndex, taprootWitnessProgram, amount]
 */
export function extractSharedUtxo(
  script: Buffer
): ExtractSharedUtxoResult | undefined {
  const stack = bscript.decompile(script);
  if (!stack) {
    throw new Error('Invalid script');
  }

  // if is a shared utxo, the script MUST begin with `mustHaveChangeOutput` opcodes.
  if (stack.length < 12) {
    return undefined;
  }

  if (
    typeof stack.at(0) !== 'number' ||
    !numberEqual(stack.at(1), OPS.OP_INSPECTOUTPUTSCRIPTPUBKEY) ||
    !numberEqual(stack.at(2), OPS.OP_1) ||
    !numberEqual(stack.at(3), OPS.OP_EQUALVERIFY) ||
    !Buffer.isBuffer(stack.at(4)) ||
    !numberEqual(stack.at(5), OPS.OP_EQUALVERIFY) ||
    typeof stack.at(6) !== 'number' ||
    !numberEqual(stack.at(7), OPS.OP_INSPECTOUTPUTVALUE) ||
    !numberEqual(stack.at(8), OPS.OP_1) ||
    !numberEqual(stack.at(9), OPS.OP_EQUALVERIFY) ||
    !Buffer.isBuffer(stack.at(10)) ||
    !numberEqual(stack.at(11), OPS.OP_EQUALVERIFY)
  ) {
    return undefined;
  }

  const outputIndex = bscript.number.decode(stack.at(0) as Buffer, 4, false);
  const taprootWitnessProgram = stack.at(4) as Buffer;
  const amount = new BufferReader(stack.at(10) as Buffer).readInt32();

  return {
    outputIndex,
    taprootWitnessProgram,
    amount,
  };
}

function numberEqual(any: unknown, number: number): boolean {
  return typeof any === 'number' && any === number;
}
