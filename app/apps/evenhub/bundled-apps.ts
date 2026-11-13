import { knownFolders } from "@nativescript/core";
import { readBinaryFile } from "../../native/file-access";
import { firmwareSha256 } from "../../native/firmware-files";
import {
  getInstalledEvenHubApp,
  installEvenHubPackageBytes,
  installedEvenHubPackagePath,
} from "./installed-apps";

const G2C = {
  packageId: "com.liyiyuian.tmuxor",
  version: "1.0.48",
  asset: "assets/evenhub/G2C-1.0.48-codex.ehpk",
  sha256: "6bed1e692652129b3765ab66442fe7079a1f46a1f1e5951254f42582e1e4bc49",
};

/** Install this build's G2C package without replacing a later user-installed release. */
export function ensureBundledEvenHubApps(): void {
  const current = getInstalledEvenHubApp(G2C.packageId);
  if (current && isLaterVersion(current.version, G2C.version)) return;
  if (current?.version === G2C.version) {
    const installed = readBinaryFile(installedEvenHubPackagePath(G2C.packageId));
    if (installed && sha256(installed) === G2C.sha256) return;
  }

  const bundled = readBinaryFile(`${knownFolders.currentApp().path}/${G2C.asset}`);
  if (!bundled) throw new Error(`Bundled package is missing: ${G2C.asset}`);
  const actualHash = sha256(bundled);
  if (actualHash !== G2C.sha256) {
    throw new Error(`Bundled G2C package failed verification: ${actualHash}`);
  }
  const installed = installEvenHubPackageBytes(bundled, { expectedPackageId: G2C.packageId });
  if (installed.version !== G2C.version) {
    throw new Error(`Bundled G2C version is ${installed.version}, expected ${G2C.version}.`);
  }
}

function sha256(bytes: Uint8Array): string {
  return firmwareSha256(bytes.slice().buffer);
}

function isLaterVersion(candidate: string, bundled: string): boolean {
  const a = candidate.split(".").map(Number), b = bundled.split(".").map(Number);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
