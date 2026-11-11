import * as THREE from 'three';
import {
  CrowdPoseEvaluator,
  createCharacterAssets,
  createReferenceCharacter,
  getBonePositionFromMatrices
} from '../src/character.js';

const assets = createCharacterAssets();
const evaluator = new CrowdPoseEvaluator(assets, 4);
const reference = createReferenceCharacter(assets);
const times = new Float32Array([0.013, 0.375, 0.782, 0.998]);
evaluator.evaluate(times, times.length);

let maxBoneError = 0;
let maxIndexError = 0;
const batchPosition = new THREE.Vector3();
const referencePosition = new THREE.Vector3();
const model = new THREE.Matrix4();
const inverseBind = new THREE.Matrix4();
const expected = new THREE.Matrix4();

for (let instance = 0; instance < times.length; instance++) {
  reference.mixer.setTime(times[instance]);
  reference.mesh.updateMatrixWorld(true);
  reference.skeleton.update();

  for (let bone = 0; bone < assets.boneCount; bone++) {
    getBonePositionFromMatrices(evaluator.modelBoneMatrices, instance, bone, assets.boneCount, batchPosition);
    referencePosition.setFromMatrixPosition(reference.bones[bone].matrixWorld);
    maxBoneError = Math.max(maxBoneError, batchPosition.distanceTo(referencePosition));

    const offset = (instance * assets.boneCount + bone) * 16;
    model.fromArray(evaluator.modelBoneMatrices, offset);
    inverseBind.fromArray(assets.rest.inverseBindMatrices, bone * 16);
    expected.multiplyMatrices(model, inverseBind);
    for (let element = 0; element < 16; element++) {
      maxIndexError = Math.max(maxIndexError, Math.abs(expected.elements[element] - evaluator.skinMatrices[offset + element]));
    }
  }
}

const loopTimes = new Float32Array([assets.clip.duration - 0.0005, 0.0005]);
evaluator.evaluate(loopTimes, 2);
const loopA = new THREE.Vector3();
const loopB = new THREE.Vector3();
let loopGap = 0;
for (const bone of [0, 4, 11, 14]) {
  getBonePositionFromMatrices(evaluator.modelBoneMatrices, 0, bone, assets.boneCount, loopA);
  getBonePositionFromMatrices(evaluator.modelBoneMatrices, 1, bone, assets.boneCount, loopB);
  loopGap = Math.max(loopGap, loopA.distanceTo(loopB));
}

const pass = maxBoneError < 1e-4 && maxIndexError < 1e-6 && loopGap < 0.02;
console.log(`bone error: ${maxBoneError.toExponential(6)}`);
console.log(`index error: ${maxIndexError.toExponential(6)}`);
console.log(`loop gap: ${loopGap.toExponential(6)}`);
console.log(pass ? 'VERIFY PASS' : 'VERIFY FAIL');

if (!pass) process.exitCode = 1;
