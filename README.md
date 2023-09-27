# shared-utxo-covenant

A **shared utxo** is a coin owned by several users. Each user can spend its share of the coin, but only if he provides a change output with remaining shares to the other users.

This can be achieved on the Liquid Network thanks to introspection opcodes `OP_INSPECTOUTPUTSCRIPTPUBKEY` and `OP_INSPECTOUTPUTVALUE` contraining the spender to provide a change output with a specific scriptPubKey and value.

## Building the covenant

Each stakeholder is represented by:
- the amount of the coin he owns
- a list of tapscript leaves letting to spend this amount

The function `sharedCoinTree` will build the covenant from an array of stakeholders. It recursively build all the subtrees expected by the change output and add it to the stakeholder's leaves.
