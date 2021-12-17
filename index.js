const parse = require("parse-diff");
const fs = require("fs");
const path = require("path");
const process = require("process");

/**
 * @typedef ChangedLines
 * @type {Object<string, number[]}
 */

/**
 * @typedef Violation
 * @type {Object}
 * @property {string} toolName - the name of the tool (i.e. 'PMD', 'eslint', ...)
 * @property {string} ruleId - the id of the rule
 * @property {object} rule - the Sarif rule object
 * @property {string} path - the file path relative to the root of the repository
 * @property {number} startLine - the start line number
 * @property {number} endLine - the end line number
 * @property {string} message - the violation message
 * @property {boolean} wasChanged - true if the line was changed in this diff
 * @property {"warning"|"error"|"note"|"none"} level - the level of the result (default to 'error')
 */

/**
 * Returns and object containing the changed
 * lines for each file.
 *
 * @param {parseDiff.File[]} parsedDiff - a diff object as returned by `parse-diff`
 * @return {ChangedLines} The changed files
 */
function getChangedLines(parsedDiff) {
  const changedLines = {};
  for (const diffFile of parsedDiff) {
    for (chunk of diffFile.chunks) {
      for (change of chunk.changes) {
        if (change.type != 'add') {
          continue;
        }
        const lineNumber = change.ln1 || change.ln;
        const lines = changedLines[diffFile.to] || [];
        lines.push(lineNumber);
        changedLines[diffFile.to] = lines;
      }
    }
  }
  return changedLines;
}

/**
 * @param {Object} github - a "hydrated" octokit instance
 * @param {Object} constext - a Github action context
 * @return {parseDiff.File[]} - a parsed diff file
 */
async function retrieveDiff(github, context) {
  const diff_url = context.payload.pull_request.diff_url;
  const diff = await github.request(diff_url);
  return parse(diff.data);
}

/**
 * Get the report filenames from the following places (in order):
 *   - input named "sarif_reports"
 *   - environment variable named "SARIF_REPORTS"
 *
 * @return {string[]}
 * @throws Will throw an error if sarif_reports is not set
 */
function getReportFilenames() {
  const reports = core.getInput("sarif_reports") || process.env['SARIF_REPORTS'] || "";
  return reports.split(',');
}

/**
 * Extract all the violations from the SARIF report.
 *
 * @param {object} sarif - a SARIF report object
 * @param {ChangedLines} changesLines - the changed lines in the diff
 * @return {Violation[]}
 */
function getViolations(sarif, changedLines) {
  const violations = [];
  for (const run of sarif.runs) {
    for (const result of run.results) {
      for (location of result.locations) {
        const filePath = location.physicalLocation.artifactLocation.uri;
        const f = path.relative(process.cwd(), filePath);
        const wasChanged = (changedLines[f] || []).includes(location.physicalLocation.region.startLine);
        const rule = run.tool.driver.rules[result.ruleIndex];

        violations.push({
          toolName: run.tool.driver.name,
          rule: run.tool.driver.rules[result.ruleIndex],
          ruleId: result.ruleId,
          path: f,
          startLine: location.physicalLocation.region.startLine,
          endLine: location.physicalLocation.region.endLine,
          message: result.message.text,
          wasChanged: wasChanged,
          level: result.level || 'error',
        });
      }
    }
  }
  return violations;
}

/**
 * @param {Object} context
 * @param {Violation[]} violations
 */
function createCheckRun(context, violations) {
  const annotations = [];
  let errorCount = 0;
  let warningCount = 0;
  let noticeCount = 0;

  for (const v of violations) {
    if (!v.wasChanged) {
      continue;
    }

    // map SARIF result level to github check level
    let severity;
    switch (v.level) {
      case 'error':
        severity = 'failure';
        errorCount++;
        break;
      case 'warning':
        severity = 'warning';
        warningCount++;
        break;
      default:
        severity = 'notice';
        noticeCount++;
    }

    annotations.push({
      path: v.path,
      start_line: v.startLine,
      end_line: v.startLine,
      annotation_level: severity,
      message: v.message,
      title: `${v.toolName} - ${v.ruleId}`,
    });
  }

  const checkRun = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    name: "Code Quality",
    head_sha: (context.payload.pull_request && context.payload.pull_request.head.sha) || context.sha,
    status: 'completed',
    conclusion: errorCount > 0 ? 'failure' : 'success',
    output: {
      title: `${errorCount} errors, ${warningCount} warnings, ${noticeCount} infos.`,
      summary: `${errorCount} errors, ${warningCount} warnings, ${noticeCount} infos.`,
      annotations: annotations,
    },
  };

  return checkRun;
}

/*---------- main ----------------*/
function publishSarifAnnotations(context, github) {

  const reportFiles = getReportFilenames();
  if (reportFiles.length == 0) {
    core.setFailed("sarif_reports was not set.");
    return;
  }

  const parsedDiff = await retrieveDiff(github, context);
  const changedLines = getChangedLines(parsedDiff);
  let violations = [];

  for (const reportFile of reportFiles) {
    let report;
    try {
      report = fs.readFileSync(reportFile, { encoding: 'utf8', flag: 'r' });
    } catch (err) {
      console.log(`could not open file "${reportFile}", ${err}`);
      continue;
    }

    const sarif = JSON.parse(report);
    violations = violations.concat(getViolations(sarif, changedLines));
  }

  const checkRun = createCheckRun(context, violations);
  console.log(checkRun);

  const resp = await github.rest.checks.create(checkRun);
  console.log(resp);
}

module.exports = publishSarifAnnotations;
