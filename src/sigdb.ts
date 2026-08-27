import { downloadFullSigDb, sigDbCacheComplete, sigDbRemoteRelease, syncedSigDbDir } from '@eagleoutice/flowr/project/sigdb/sigdb-download';

/**
 * Download flowR's signature database (only the `sigdb.remote.json` link file naming its shards ships with
 * flowR) and return the path to mount it from, `undefined` if there is nothing to add. Without it a call into
 * a package resolves to no export, so `library(glue); glue(...)` stays `glue` instead of `glue::glue`.
 * The shards are cached across runs, so only the first run downloads.
 * @param onProgress - reports what is downloaded, one line per asset
 */
export async function ensureSignatureDb(onProgress: (msg: string) => void = () => {}): Promise<string | undefined> {
	if(sigDbRemoteRelease() !== undefined && !sigDbCacheComplete()) {
		try {
			const { dir, manifest } = await downloadFullSigDb({ onProgress });
			return manifest ?? dir;
		} catch(e) {
			onProgress(`download failed (${(e as Error).message}), using what is cached`);
		}
	}
	return syncedSigDbDir();
}

/* running this file directly only fills the cache, which is what the docker build does */
if(require.main === module) {
	void ensureSignatureDb(msg => console.log(`sigdb: ${msg}`))
		.then(dir => console.log(dir === undefined ? 'sigdb: nothing to mount' : `sigdb: mounted from ${dir}`));
}
