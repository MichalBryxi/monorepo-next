'use strict';

const execa = require('execa');

async function getCurrentBranch(cwd) {
  return (await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout;
}

async function getCurrentCommit(cwd) {
  return (await execa('git', ['rev-parse', 'HEAD'], { cwd })).stdout;
}

async function getCommitAtTag(tag, cwd) {
  return (await execa('git', ['rev-list', '-1', tag], { cwd })).stdout;
}

async function getWorkspaceCwd(cwd) {
  return (await execa('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout;
}

module.exports = {
  getCurrentBranch,
  getCurrentCommit,
  getCommitAtTag,
  getWorkspaceCwd,
};