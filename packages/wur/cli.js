#!/usr/bin/env node
/**
 * @platformatic/wur — slim Workflow Upgrade Risk CLI for CI/ops.
 * Does not start the workflow service (see @platformatic/workflow for that).
 */
import { runWurCli } from './lib/cli-wur.ts'

const code = await runWurCli(process.argv.slice(2))
process.exit(code)
