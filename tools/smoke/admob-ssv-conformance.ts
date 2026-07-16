import { runAdMobSsvConformance } from '@mpgd/game-services/admob-ssv-conformance';

const report = await runAdMobSsvConformance();

console.log(`AdMob SSV conformance passed (${String(report.checks.length)} checks).`);
