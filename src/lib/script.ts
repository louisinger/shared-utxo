import { script } from 'liquidjs-lib';
import { BufferWriter } from 'liquidjs-lib/src/bufferutils';
import { OPS } from 'liquidjs-lib/src/ops';

export function mustHaveChangeOutput(
  outputIndex: number,
  taprootWitnessProgram: Buffer,
  amount: number
): (Buffer | number)[] {
  const index = script.number.encode(outputIndex);
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
