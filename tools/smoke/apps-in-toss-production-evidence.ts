import {
  appsInTossProductionEvidenceConformanceScenarios,
  runAppsInTossProductionEvidenceConformance,
} from '@mpgd/game-services/apps-in-toss-evidence-verification-conformance';

const report = await runAppsInTossProductionEvidenceConformance();

if (
  report.passedScenarios.length
  !== appsInTossProductionEvidenceConformanceScenarios.length
) {
  throw new Error('Apps in Toss production evidence smoke did not run every scenario.');
}

console.log(
  `Apps in Toss production evidence conformance passed: ${report.passedScenarios.join(', ')}`,
);
