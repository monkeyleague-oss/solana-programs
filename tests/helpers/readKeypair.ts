import { readFileSync } from "fs";
import * as anchor from "@project-serum/anchor";

export function readKeypairFromFile(path: string) {
  let rawdata = readFileSync(path);
  let keyData = JSON.parse(rawdata.toString("utf-8"));
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(keyData));
}
