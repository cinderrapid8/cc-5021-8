import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BONE_DEFINITIONS,
  CrowdPoseEvaluator,
  SKELETON_DETAIL_COARSE,
  SKELETON_DETAIL_FULL,
  SKELETON_DETAIL_LEVELS,
  SKELETON_DETAIL_MEDIUM,
  applyFullDetailBudget,
  createCharacterAssets,
  createReferenceCharacter,
  getBonePositionFromMatrices,
  getSkeletonDetailMask,
  getSkeletonDetailName,
  selectSkeletonDetailLevel
} from '../src/character.js';

const THRESHOLDS = [34, 60];
const HYSTERESIS = 2.5;
const FULL_DETAIL_BUDGET = 3;
const INSTANCE_COUNT = 6;
const STEP_COUNT = 96;
const DT = 0.017;
const MATRIX_TOLERANCE = 1e-4;
const SKIN_TOLERANCE = 1e-5;
const MOTION_EPSILON = 1e-4;
const EVIDENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'evidence');

const INSTANCES = [
  { phase: 0.000, speed: 1.00 },
  { phase: 0.004, speed: 1.07 },
  { phase: 0.500, speed: 0.93 },
  { phase: 0.504, speed: 1.11 },
  { phase: 0.250, speed: 1.03 },
  { phase: 0.254, speed: 0.97 }
];

const DISTANCE_PATTERN = [
  20, 70, 33.9, 34.1, 35.2, 35.3, 32.75, 32.7,
  59.9, 60.1, 61.2, 61.3, 58.75, 58.7, 45, 65
];

function wrap01(value) {
  const wrapped = value % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

function digest(values) {
  return createHash('sha256').update(values.join('|')).digest('hex');
}

function rounded(values, precision = 6) {
  return values.map((value) => value.toFixed(precision));
}

function matrixValues(matrix, offset) {
  const values = new Array(16);
  for (let element = 0; element < 16; element++) values[element] = matrix[offset + element];
  return values;
}

function runBoundaryRegression() {
  const failures = [];
  const checks = [];

  const check = (label, condition, detail = '') => {
    checks.push({ label, pass: Boolean(condition), detail });
    if (!condition) failures.push({ kind: 'boundary', label, detail });
  };

  check('distance 0 -> full', selectSkeletonDetailLevel(0) === SKELETON_DETAIL_FULL);
  check('distance 33.999 -> full', selectSkeletonDetailLevel(33.999) === SKELETON_DETAIL_FULL);
  check('distance 34 -> medium', selectSkeletonDetailLevel(34) === SKELETON_DETAIL_MEDIUM);
  check('distance 59.999 -> medium', selectSkeletonDetailLevel(59.999) === SKELETON_DETAIL_MEDIUM);
  check('distance 60 -> coarse', selectSkeletonDetailLevel(60) === SKELETON_DETAIL_COARSE);
  check('distance 1000 -> coarse', selectSkeletonDetailLevel(1000) === SKELETON_DETAIL_COARSE);

  check(
    'full holds inside lower hysteresis band',
    selectSkeletonDetailLevel(35.24, SKELETON_DETAIL_FULL, THRESHOLDS, HYSTERESIS) === SKELETON_DETAIL_FULL
  );
  check(
    'full enters medium at hysteresis edge',
    selectSkeletonDetailLevel(35.25, SKELETON_DETAIL_FULL, THRESHOLDS, HYSTERESIS) === SKELETON_DETAIL_MEDIUM
  );
  check(
    'medium holds above lower exit edge',
    selectSkeletonDetailLevel(32.76, SKELETON_DETAIL_MEDIUM, THRESHOLDS, HYSTERESIS) === SKELETON_DETAIL_MEDIUM
  );
  check(
    'medium returns to full at lower exit edge',
    selectSkeletonDetailLevel(32.75, SKELETON_DETAIL_MEDIUM, THRESHOLDS, HYSTERESIS) === SKELETON_DETAIL_FULL
  );
  check(
    'medium holds inside upper hysteresis band',
    selectSkeletonDetailLevel(61.24, SKELETON_DETAIL_MEDIUM, THRESHOLDS, HYSTERESIS) === SKELETON_DETAIL_MEDIUM
  );
  check(
    'medium enters coarse at upper hysteresis edge',
    selectSkeletonDetailLevel(61.25, SKELETON_DETAIL_MEDIUM, THRESHOLDS, HYSTERESIS) === SKELETON_DETAIL_COARSE
  );
  check(
    'coarse holds above upper exit edge',
    selectSkeletonDetailLevel(58.76, SKELETON_DETAIL_COARSE, THRESHOLDS, HYSTERESIS) === SKELETON_DETAIL_COARSE
  );
  check(
    'coarse returns to medium at upper exit edge',
    selectSkeletonDetailLevel(58.75, SKELETON_DETAIL_COARSE, THRESHOLDS, HYSTERESIS) === SKELETON_DETAIL_MEDIUM
  );

  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  check('rejects non-finite distance', throws(() => selectSkeletonDetailLevel(Number.NaN)));
  check('rejects negative distance', throws(() => selectSkeletonDetailLevel(-1)));
  check('rejects unknown current level', throws(() => selectSkeletonDetailLevel(10, 9)));
  check('rejects negative hysteresis', throws(() => selectSkeletonDetailLevel(10, 0, THRESHOLDS, -1)));
  check('rejects descending thresholds', throws(() => selectSkeletonDetailLevel(10, 0, [60, 34])));

  const levels = new Uint8Array(INSTANCE_COUNT).fill(SKELETON_DETAIL_FULL);
  const distances = new Float64Array([1, 2, 3, 4, 5, 6]);
  const demoted = applyFullDetailBudget(levels, distances, INSTANCE_COUNT, 2);
  check('budget demotes farthest full-detail instances', demoted === 4 && levels[0] === SKELETON_DETAIL_FULL && levels[1] === SKELETON_DETAIL_FULL && levels[2] === SKELETON_DETAIL_MEDIUM && levels[3] === SKELETON_DETAIL_MEDIUM && levels[4] === SKELETON_DETAIL_MEDIUM && levels[5] === SKELETON_DETAIL_MEDIUM, `demoted=${demoted}`);
  check('budget rejects invalid active count', throws(() => applyFullDetailBudget(new Uint8Array(2), new Float64Array(2), 3, 1)));
  check('budget rejects negative budget', throws(() => applyFullDetailBudget(new Uint8Array(2), new Float64Array(2), 2, -1)));

  for (let level = 0; level < SKELETON_DETAIL_LEVELS.length; level++) {
    const mask = getSkeletonDetailMask(level);
    let animated = 0;
    let monotone = true;
    for (let bone = 0; bone < BONE_DEFINITIONS.length; bone++) {
      if (mask[bone]) animated++;
      const parent = BONE_DEFINITIONS[bone].parent;
      if (mask[bone] && parent !== -1 && !mask[parent]) monotone = false;
    }
    checks.push({ label: `detail ${getSkeletonDetailName(level)} mask`, pass: monotone, detail: `${animated} animated bones` });
    if (!monotone) failures.push({ kind: 'boundary', label: `detail ${level} mask is not monotone` });
    if (level === SKELETON_DETAIL_FULL) check('full animates every bone', animated === BONE_DEFINITIONS.length);
    if (level === SKELETON_DETAIL_MEDIUM) check('medium animates 12 bones', animated === 12);
    if (level === SKELETON_DETAIL_COARSE) check('coarse animates 4 bones', animated === 4);
  }

  return { failures, checks };
}

function runScenario() {
  const assets = createCharacterAssets();
  const evaluator = new CrowdPoseEvaluator(assets, INSTANCE_COUNT);
  const reference = createReferenceCharacter(assets);
  const times = new Float32Array(INSTANCE_COUNT);
  const distances = new Float64Array(INSTANCE_COUNT);
  const levels = new Uint8Array(INSTANCE_COUNT).fill(SKELETON_DETAIL_FULL);
  const baseLevels = new Uint8Array(INSTANCE_COUNT).fill(SKELETON_DETAIL_FULL);
  const previousLevels = new Uint8Array(INSTANCE_COUNT).fill(255);
  const lastCoarseHand = new Float64Array(INSTANCE_COUNT * 3).fill(Number.NaN);
  const pendingSwitches = new Array(INSTANCE_COUNT).fill(null);
  const lastMatrixDigests = new Array(INSTANCE_COUNT).fill(null);
  const previousTimes = new Float64Array(INSTANCE_COUNT).fill(Number.NaN);

  const failures = [];
  const snapshots = [];
  const switchEvents = [];
  const detailCounts = [0, 0, 0];
  const digestParts = [];
  let maxMatrixError = 0;
  let maxSkinError = 0;
  let maxBindingError = 0;
  let maxInheritanceError = 0;
  let maxCoarseMotion = 0;
  let matrixComparisons = 0;
  let levelChanges = 0;
  let roundTrips = 0;
  let budgetDemotions = 0;
  let budgetAdjusted = 0;
  let simulatedTime = 0;

  const batchPosition = new THREE.Vector3();
  const referencePosition = new THREE.Vector3();
  const model = new THREE.Matrix4();
  const inverseBind = new THREE.Matrix4();
  const expectedSkin = new THREE.Matrix4();
  const restLocal = new THREE.Matrix4();
  const inherited = new THREE.Matrix4();
  const expectedMatrices = new Array(BONE_DEFINITIONS.length).fill(null).map(() => new THREE.Matrix4());
  const parentMatrix = new THREE.Matrix4();

  const recordFailure = (entry) => {
    if (failures.length < 240) failures.push(entry);
  };

  for (let step = 0; step < STEP_COUNT; step++) {
    simulatedTime = step * DT;
    const nearBurst = step % 16 === 7 || step % 16 === 8;

    for (let instance = 0; instance < INSTANCE_COUNT; instance++) {
      const config = INSTANCES[instance];
      times[instance] = wrap01(config.phase + simulatedTime * config.speed);
      distances[instance] = nearBurst
        ? 20 + instance * 0.1
        : DISTANCE_PATTERN[(step + instance * 5) % DISTANCE_PATTERN.length];

      const previous = levels[instance];
      baseLevels[instance] = selectSkeletonDetailLevel(distances[instance], baseLevels[instance], THRESHOLDS, HYSTERESIS);
      levels[instance] = baseLevels[instance];
      if (previous !== 255 && levels[instance] !== previous) {
        levelChanges++;
        pendingSwitches[instance] = {
          step,
          instance,
          time: times[instance],
          from: getSkeletonDetailName(previous),
          to: getSkeletonDetailName(levels[instance]),
          distance: distances[instance]
        };
        if (levels[instance] > previous) {
          roundTrips++;
        }
      }
    }

    budgetDemotions += applyFullDetailBudget(levels, distances, INSTANCE_COUNT, FULL_DETAIL_BUDGET);
    evaluator.evaluate(times, INSTANCE_COUNT, levels);

    for (let instance = 0; instance < INSTANCE_COUNT; instance++) {
      const level = levels[instance];
      detailCounts[level]++;

      const baseLevel = baseLevels[instance];
      if (level !== baseLevel) {
        budgetAdjusted++;
        if (!(baseLevel === SKELETON_DETAIL_FULL && level === SKELETON_DETAIL_MEDIUM)) {
          recordFailure({ kind: 'budgetState', step, instance, baseLevel, level });
        }
      }

      const binding = evaluator.getPoseBinding(instance);
      const bindingError = Math.max(
        Math.abs(binding.time - times[instance]),
        Math.abs(binding.detailLevel - level),
        Math.abs(binding.row - instance)
      );
      maxBindingError = Math.max(maxBindingError, bindingError);
      if (bindingError !== 0) {
        recordFailure({ kind: 'binding', step, instance, expected: { row: instance, time: times[instance], level }, actual: binding });
      }

      reference.mixer.setTime(times[instance]);
      reference.mesh.updateMatrixWorld(true);
      reference.skeleton.update();

      const mask = getSkeletonDetailMask(level);
      for (let bone = 0; bone < BONE_DEFINITIONS.length; bone++) {
        const parent = BONE_DEFINITIONS[bone].parent;
        const animated = mask[bone] === 1;

        if (animated) {
          expectedMatrices[bone].copy(reference.bones[bone].matrixWorld);
        } else {
          restLocal.makeTranslation(
            BONE_DEFINITIONS[bone].position[0],
            BONE_DEFINITIONS[bone].position[1],
            BONE_DEFINITIONS[bone].position[2]
          );
          if (parent === -1) expectedMatrices[bone].copy(restLocal);
          else expectedMatrices[bone].multiplyMatrices(expectedMatrices[parent], restLocal);
        }

        const offset = (instance * assets.boneCount + bone) * 16;
        model.fromArray(evaluator.modelBoneMatrices, offset);
        let boneMatrixError = 0;
        for (let element = 0; element < 16; element++) {
          boneMatrixError = Math.max(boneMatrixError, Math.abs(expectedMatrices[bone].elements[element] - evaluator.modelBoneMatrices[offset + element]));
        }
        maxMatrixError = Math.max(maxMatrixError, boneMatrixError);
        matrixComparisons++;

        if (boneMatrixError > MATRIX_TOLERANCE) {
          recordFailure({
            kind: 'boneMatrix',
            step,
            instance,
            bone,
            boneName: BONE_DEFINITIONS[bone].name,
            detail: getSkeletonDetailName(level),
            expected: rounded(expectedMatrices[bone].elements),
            actual: rounded(matrixValues(evaluator.modelBoneMatrices, offset))
          });
        }

        if (!animated && parent !== -1) {
          parentMatrix.fromArray(evaluator.modelBoneMatrices, (instance * assets.boneCount + parent) * 16);
          inherited.multiplyMatrices(parentMatrix, restLocal);
          getBonePositionFromMatrices(evaluator.modelBoneMatrices, instance, bone, assets.boneCount, batchPosition);
          referencePosition.set(inherited.elements[12], inherited.elements[13], inherited.elements[14]);
          const inheritanceError = batchPosition.distanceTo(referencePosition);
          maxInheritanceError = Math.max(maxInheritanceError, inheritanceError);
          if (inheritanceError > MATRIX_TOLERANCE) {
            recordFailure({
              kind: 'inheritance',
              step,
              instance,
              bone,
              boneName: BONE_DEFINITIONS[bone].name,
              expected: referencePosition.toArray(),
              actual: batchPosition.toArray()
            });
          }
        }

        if (animated) {
          inverseBind.fromArray(assets.rest.inverseBindMatrices, bone * 16);
          expectedSkin.multiplyMatrices(model, inverseBind);
          let skinError = 0;
          for (let element = 0; element < 16; element++) {
            skinError = Math.max(skinError, Math.abs(expectedSkin.elements[element] - evaluator.skinMatrices[offset + element]));
            skinError = Math.max(skinError, Math.abs(reference.skeleton.boneMatrices[bone * 16 + element] - evaluator.skinMatrices[offset + element]));
          }
          maxSkinError = Math.max(maxSkinError, skinError);
          if (skinError > SKIN_TOLERANCE) {
            recordFailure({ kind: 'skinMatrix', step, instance, bone, boneName: BONE_DEFINITIONS[bone].name, error: skinError });
          }
        }
      }

      const coarseBase = instance * 3;
      if (level !== SKELETON_DETAIL_FULL) {
        getBonePositionFromMatrices(evaluator.modelBoneMatrices, instance, 7, assets.boneCount, batchPosition);
        if (Number.isFinite(lastCoarseHand[coarseBase])) {
          const motion = Math.hypot(
            batchPosition.x - lastCoarseHand[coarseBase],
            batchPosition.y - lastCoarseHand[coarseBase + 1],
            batchPosition.z - lastCoarseHand[coarseBase + 2]
          );
          maxCoarseMotion = Math.max(maxCoarseMotion, motion);
        }
        lastCoarseHand[coarseBase] = batchPosition.x;
        lastCoarseHand[coarseBase + 1] = batchPosition.y;
        lastCoarseHand[coarseBase + 2] = batchPosition.z;
      } else {
        lastCoarseHand[coarseBase] = Number.NaN;
        lastCoarseHand[coarseBase + 1] = Number.NaN;
        lastCoarseHand[coarseBase + 2] = Number.NaN;
      }

      const matrixBase = instance * assets.boneCount * 16;
      const allMatrixValues = new Array(assets.boneCount * 16);
      for (let element = 0; element < allMatrixValues.length; element++) {
        allMatrixValues[element] = evaluator.modelBoneMatrices[matrixBase + element];
      }
      const currentMatrixDigest = digest(rounded(allMatrixValues, 5));

      const pending = pendingSwitches[instance];
      if (pending) {
        switchEvents.push({
          ...pending,
          timeBefore: previousTimes[instance],
          previousMatrixDigest: lastMatrixDigests[instance],
          matrixDigest: currentMatrixDigest
        });
        pendingSwitches[instance] = null;
      }

      const record = previousLevels[instance] !== levels[instance] || step % 8 === 0;
      previousLevels[instance] = levels[instance];
      if (record) {
        getBonePositionFromMatrices(evaluator.modelBoneMatrices, instance, 0, assets.boneCount, batchPosition);
        const hips = batchPosition.toArray();
        getBonePositionFromMatrices(evaluator.modelBoneMatrices, instance, 11, assets.boneCount, batchPosition);
        const upperLeg = batchPosition.toArray();
        snapshots.push({
          step,
          instance,
          time: times[instance],
          detailLevel: level,
          detailName: getSkeletonDetailName(level),
          baseLevel: baseLevels[instance],
          baseLevelName: getSkeletonDetailName(baseLevels[instance]),
          poseRow: binding.row,
          bindingTime: binding.time,
          bindingLevel: binding.detailLevel,
          distance: distances[instance],
          hips,
          upperLeg,
          matrixDigest: currentMatrixDigest
        });
      }

      digestParts.push(`${step}|${instance}|${times[instance].toFixed(9)}|${level}`);
      for (let element = 0; element < assets.boneCount * 16; element++) {
        digestParts.push(evaluator.modelBoneMatrices[matrixBase + element].toFixed(5));
      }

      previousTimes[instance] = times[instance];
      lastMatrixDigests[instance] = currentMatrixDigest;
    }
  }

  if (maxCoarseMotion <= MOTION_EPSILON) {
    recordFailure({ kind: 'frozenCoarseMotion', maxCoarseMotion });
  }

  return {
    failures,
    snapshots,
    switchEvents,
    digest: digest(digestParts),
    stats: {
      steps: STEP_COUNT,
      instances: INSTANCE_COUNT,
      matrixComparisons,
      maxMatrixError,
      maxSkinError,
      maxBindingError,
      maxInheritanceError,
      maxCoarseMotion,
      levelChanges,
      roundTrips,
      budgetDemotions,
      budgetAdjusted,
      detailCounts,
      fullDetailBudget: FULL_DETAIL_BUDGET,
      thresholds: THRESHOLDS,
      hysteresis: HYSTERESIS
    }
  };
}

function summarizeFailures(failures) {
  const counts = new Map();
  for (const failure of failures) counts.set(failure.kind, (counts.get(failure.kind) ?? 0) + 1);
  return Object.fromEntries(counts);
}

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });

  const boundary = runBoundaryRegression();
  const first = runScenario();
  const second = runScenario();
  const rerunMatches = first.digest === second.digest;
  const failures = [...boundary.failures, ...first.failures, ...second.failures];

  if (!rerunMatches) failures.push({ kind: 'nonDeterministicRerun', first: first.digest, second: second.digest });
  if (first.failures.length !== 0 || second.failures.length !== 0) {
    failures.push({ kind: 'runtimeEvidence', first: first.failures.length, second: second.failures.length });
  }

  const evidence = {
    scenario: {
      detailLevels: SKELETON_DETAIL_LEVELS.map((level) => level.name),
      thresholds: THRESHOLDS,
      hysteresis: HYSTERESIS,
      fullDetailBudget: FULL_DETAIL_BUDGET,
      instances: INSTANCES,
      distancePattern: DISTANCE_PATTERN,
      stepCount: STEP_COUNT,
      dt: DT
    },
    boundaryChecks: boundary.checks,
    rerun: {
      firstDigest: first.digest,
      secondDigest: second.digest,
      matches: rerunMatches
    },
    stats: first.stats,
    switchEvents: first.switchEvents,
    snapshots: first.snapshots,
    failures,
    failureSummary: summarizeFailures(failures)
  };

  await writeFile(join(EVIDENCE_DIR, 'crowd-hierarchy-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  if (failures.length > 0) {
    await writeFile(join(EVIDENCE_DIR, 'crowd-hierarchy-failure.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  } else {
    await unlink(join(EVIDENCE_DIR, 'crowd-hierarchy-failure.json')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  const stats = first.stats;
  console.log(`[crowd-hierarchy] steps=${stats.steps} instances=${stats.instances} matrixComparisons=${stats.matrixComparisons}`);
  console.log(`[crowd-hierarchy] levelChanges=${stats.levelChanges} roundTrips=${stats.roundTrips} budgetDemotions=${stats.budgetDemotions} budgetAdjusted=${stats.budgetAdjusted}`);
  console.log(`[crowd-hierarchy] maxMatrixError=${stats.maxMatrixError.toExponential(3)} maxSkinError=${stats.maxSkinError.toExponential(3)}`);
  console.log(`[crowd-hierarchy] maxBindingError=${stats.maxBindingError.toExponential(3)} maxInheritanceError=${stats.maxInheritanceError.toExponential(3)}`);
  console.log(`[crowd-hierarchy] maxCoarseMotion=${stats.maxCoarseMotion.toExponential(3)} detailCounts=${stats.detailCounts.join('/')}`);
  console.log(`[crowd-hierarchy] rerun digest ${rerunMatches ? 'MATCH' : 'MISMATCH'}: ${first.digest.slice(0, 16)} / ${second.digest.slice(0, 16)}`);

  for (const failure of failures.slice(0, 10)) console.error(`[crowd-hierarchy] failure ${JSON.stringify(failure)}`);
  console.log(failures.length === 0 ? 'CROWD HIERARCHY PASS' : 'CROWD HIERARCHY FAIL');
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
