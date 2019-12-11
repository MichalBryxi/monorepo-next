'use strict';

const { promisify } = require('util');
const conventionalRecommendedBump = promisify(require('conventional-recommended-bump'));
const path = require('path');
const {
  read: readJson,
} = require('./json');
const { trackNewVersion } = require('./version');
const semver = require('semver');

async function getReleaseType(packageName, cwd) {
  let tagPrefix = `${packageName}@`;

  let originalCwd = process.cwd();

  let myReleaseType;
  try {
    process.chdir(cwd);

    myReleaseType = (await conventionalRecommendedBump({
      // preset: require('standard-version/defaults').preset,
      preset: require('standard-version/lib/preset-loader')({}),
      path: cwd,
      tagPrefix,
    })).releaseType;
  } finally {
    process.chdir(originalCwd);
  }

  return myReleaseType;
}

const orderedReleaseTypes = ['patch', 'minor', 'major'];

function isReleaseTypeLessThan(type1, type2) {
  return orderedReleaseTypes.indexOf(type1) < orderedReleaseTypes.indexOf(type2);
}

async function init(dag, releaseTrees, releaseType) {
  let {
    packageName: name,
    cwd,
  } = dag;

  let packageJsonPath = path.join(cwd, 'package.json');

  let { version } = await readJson(packageJsonPath);

  if (version) {
    let matches = version.match(/(.*)-detached.*/);

    if (matches) {
      version = matches[1];
    }
  }

  if (!releaseType) {
    releaseType = await getReleaseType(name, cwd);
  }

  return releaseTrees[name] = {
    oldVersion: version,
    releaseType,
    cwd,
    name,
    canPublish: dag.isPackage,
    canBumpVersion: !!(version && name),
  };
}

async function firstPass({
  releaseTrees,
  packagesWithChanges,
}) {
  for (let { dag, changedFiles } of packagesWithChanges) {
    if (!changedFiles.length) {
      continue;
    }

    await init(dag, releaseTrees);
  }
}

async function secondPass({
  releaseTrees,
  packagesWithChanges,
  shouldBumpInRangeDependencies,
  shouldInheritGreaterReleaseType,
}) {
  for (let { dag, changedFiles } of packagesWithChanges) {
    if (!changedFiles.length) {
      continue;
    }

    await (async function crawlDag({
      dag,
      parent,
    }) {
      let doesPackageHaveChanges = !!releaseTrees[dag.packageName];
      if (!doesPackageHaveChanges) {
        if (dag.isPackage && shouldInheritGreaterReleaseType && dag.dependencyType === 'dependencies' && shouldBumpInRangeDependencies) {
          await init(dag, releaseTrees, parent.releaseType);
        } else if (shouldBumpInRangeDependencies) {
          await init(dag, releaseTrees);
        } else {
          return;
        }
      }

      for (let node of dag.dependents) {
        if (node.isCycle) {
          continue;
        }

        await crawlDag({
          dag: node,
          parent: releaseTrees[dag.packageName],
        });
      }
    })({
      dag,
    });
  }
}

async function thirdPass({
  releaseTrees,
  packagesWithChanges,
  shouldInheritGreaterReleaseType,
}) {
  for (let { dag, changedFiles } of packagesWithChanges) {
    if (!changedFiles.length) {
      continue;
    }

    await (async function crawlDag({
      dag,
      parent,
    }) {
      let current = releaseTrees[dag.packageName];

      if (!current) {
        return;
      }

      let currentReleaseType = current.releaseType;

      let incomingReleaseType = parent ? parent.releaseType : currentReleaseType;

      if (shouldInheritGreaterReleaseType && dag.dependencyType === 'dependencies' && isReleaseTypeLessThan(currentReleaseType, incomingReleaseType)) {
        currentReleaseType = incomingReleaseType;
      }

      current.releaseType = currentReleaseType;

      for (let node of dag.dependents) {
        if (!node.isPackage || node.isCycle) {
          continue;
        }

        await crawlDag({
          dag: node,
          parent: releaseTrees[dag.packageName],
        });
      }
    })({
      dag,
    });
  }
}

async function fourthPass({
  workspaceMeta,
  releaseTrees,
  packagesWithChanges,
  shouldBumpInRangeDependencies,
}) {
  for (let { dag, changedFiles } of packagesWithChanges) {
    if (!changedFiles.length) {
      continue;
    }

    await (async function crawlDag({
      dag,
    }) {
      let current = releaseTrees[dag.packageName];

      if (!current) {
        return;
      }

      let myPackage = workspaceMeta.packages[dag.packageName] || workspaceMeta;

      for (let type of [
        'dependencies',
        'devDependencies',
      ]) {
        let deps = myPackage[type];
        current[type] = [];

        for (let name in deps) {
          let releaseTree = releaseTrees[name];
          if (!releaseTree) {
            continue;
          }

          let oldRange = deps[name];
          let newRange = oldRange.replace(/ +\|\| +[\d.]*-detached.*/, '');

          let newVersion = semver.inc(releaseTree.oldVersion, releaseTree.releaseType);

          if (shouldBumpInRangeDependencies || !semver.satisfies(newVersion, newRange)) {
            newRange = trackNewVersion({
              name,
              oldRange,
              newRange,
              newVersion,
            });
          }

          current[type].push({
            name,
            newRange,
          });
        }
      }

      for (let node of dag.dependents) {
        if (node.isCycle) {
          continue;
        }

        await crawlDag({
          dag: node,
        });
      }
    })({
      dag,
    });
  }
}

async function buildReleaseGraph({
  workspaceMeta,
  packagesWithChanges,
  shouldBumpInRangeDependencies,
  shouldInheritGreaterReleaseType,
}) {
  let releaseTrees = {};

  await firstPass({
    releaseTrees,
    packagesWithChanges,
  });

  // only packages with changes have been analyzed

  await secondPass({
    releaseTrees,
    packagesWithChanges,
    shouldBumpInRangeDependencies,
    shouldInheritGreaterReleaseType,
  });

  // packages without changes, but need to be analyzed because of options

  await thirdPass({
    releaseTrees,
    packagesWithChanges,
    shouldInheritGreaterReleaseType,
  });

  // dependents have now inherited release type

  await fourthPass({
    workspaceMeta,
    releaseTrees,
    packagesWithChanges,
    shouldBumpInRangeDependencies,
  });

  // dependencies are now bumped if needed

  return Object.values(releaseTrees);
}

module.exports = buildReleaseGraph;
