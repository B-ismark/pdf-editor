// Ambient declarations for dependencies without bundled types. They're used
// only inside the lazily-loaded signing path (see pdf/sign.ts), which treats
// them as untyped (`any`) glue.
declare module "node-forge";
declare module "buffer";
