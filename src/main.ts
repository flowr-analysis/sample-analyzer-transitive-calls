import { FlowrAnalyzerBuilder } from '@eagleoutice/flowr/project/flowr-analyzer-builder';
import { fileProtocol } from '@eagleoutice/flowr/r-bridge/retriever.js';
import { jsonReplacer } from '@eagleoutice/flowr/util/json';
import { log, LogLevel } from '@eagleoutice/flowr/util/log';
import fs from 'fs';
import { collectMatches } from './collect';
import { pattern } from './pattern';
import { ensureSignatureDb } from './sigdb';

async function main(folder: string, outputFile: string) {
	log.updateSettings(s => {
		s.settings.minLevel = LogLevel.Fatal;
	});

	const builder = new FlowrAnalyzerBuilder().setEngine('tree-sitter');
	/* 1. the signature database names what a call resolves to (`glue::glue` rather than `glue`) */
	const sigDb = await ensureSignatureDb(msg => console.log(`sigdb: ${msg}`));
	if(sigDb !== undefined) {
		builder.configure('solver.sigdb.additionalPaths', [sigDb]);
	}

	const analyzer = await builder.build();
	analyzer.addRequest(fileProtocol + folder);
	try {
		const time = Date.now();
		/* 2. match the pattern and collect what each match reaches, see `src/collect.ts` */
		const matches = await collectMatches(analyzer, pattern);

		const resultString = JSON.stringify({ matches }, jsonReplacer, 2);
		fs.writeFileSync(outputFile, resultString, 'utf-8');
		console.log(`Results written to ${outputFile}
   * ${matches.length} matches, ${matches.reduce((s, m) => s + m.transitiveCalls.length, 0)} transitive calls, ${matches.reduce((s, m) => s + m.references.length, 0)} references
   * considered ${analyzer.inspectContext().files.loadingOrder.getLoadingOrder().length} files
   * took ${Date.now() - time}ms`);
	} finally {
		analyzer.close();
	}
}

if(process.argv.length < 4) {
	console.error('Usage: ts-node src/main.ts <folder> <output-file>');
	process.exit(1);
}

void main(process.argv[2], process.argv[3]).catch(err => {
	console.error('Error during analysis:', err);
	process.exit(1);
});
