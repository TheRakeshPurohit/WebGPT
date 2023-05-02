// This is the condensed version of the script, just to prove how short it can actually be.

const NaiveMatMulBlock = new NaiveMatMulBlockClass();
const FastMatMulBlock = new FastMatMulBlockClass();
const FastRowAddBlock = new FastRowAddBlockClass();
const FastFFNBlock = new FastFFNBlockClass();
const AttentionBlock = new AttentionBlockClass();
const ResidualBlock = new ResidualBlockClass();
const EmbedBlock = new EmbedBlockClass();
const OldDeEmbedBlock = new OldDeEmbedBlockClass();
const GeluBlock = new GeluBlockClass();
const LayerNormBlock = new LayerNormBlockClass();
const TransposeBlock = new TransposeBlockClass();
const SoftmaxBlock = new SoftmaxBlockClass();

const operations = [
  NaiveMatMulBlock,
  FastMatMulBlock,
  FastRowAddBlock,
  FastFFNBlock,
  AttentionBlock,
  ResidualBlock,
  EmbedBlock,
  OldDeEmbedBlock,
  GeluBlock,
  LayerNormBlock,
  TransposeBlock,
  SoftmaxBlock,
];

function initializeOperations(device) {
  for (const operation of operations) operation.initialize(device);
}

function destroyOperationBuffers() {
  for (const operation of operations) operation.destroyBuffers();
}

const bufferUsageDict = {
  copy_from: GPUBufferUsage.COPY_SRC,
  copy_to: GPUBufferUsage.COPY_DST,
  storage: GPUBufferUsage.STORAGE,
  uniform: GPUBufferUsage.UNIFORM,
  map_read: GPUBufferUsage.MAP_READ,
};

async function fetchBin(url) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  return new Float32Array(buffer);
}

const wgSize = (dim, size) => Math.min(Math.ceil(dim / size), 256);

function sampleFromDistribution(probs) {
  const rand = Math.random();
  let cumulativeProb = 0;
  for (let i = 0; i < probs.length; i++) {
    cumulativeProb += probs[i];
    if (rand < cumulativeProb) {
      return i;
    }
  }
  return probs.length - 1;
}

function cpuSoftmax(logits, temperature = 1.0) {
  const maxLogit = Math.max(...logits);
  const expLogits = logits.map((logit) => Math.exp((logit - maxLogit) / temperature));
  const sumExpLogits = expLogits.reduce((a, b) => a + b, 0);
  return expLogits.map((expLogit) => expLogit / sumExpLogits);
}

function selectTopK(probs, top_k) {
  const sortedIndices = Array.from(probs)
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value)
    .map(({ index }) => index);
  const topKIndices = sortedIndices.slice(0, top_k);
  const topKProbs = topKIndices.map((index) => probs[index]);
  return { topKIndices, topKProbs };
}

function transpose(array, input_rows, input_cols) {
  if (array.length !== input_rows * input_cols) throw new Error("Transpose dims failed");

  const transpose = [];
  for (let col = 0; col < input_cols; col++) {
    for (let row = 0; row < input_rows; row++) {
      transpose.push(array[row * input_cols + col]);
    }
  }

  return new Float32Array(transpose);
}

function leastPrimeFactor(n, start = 2) {
  for (let i = start; i <= Math.sqrt(n); i++) {
    if (n % i === 0) return i;
  }
  return n;
}

function formatAsMatrix(floatArray, dimA, dimB) {
  const resultMatrix = [];
  for (let i = 0; i < dimA; i++) {
    resultMatrix.push(floatArray.slice(i * dimB, (i + 1) * dimB));
  }
  return resultMatrix;
}

class Tokenizer {
  constructor() {
    this.encoder = undefined;
    this.decoder = undefined;
    this.vocab_size = undefined;
  }

  async load() {
    throw new Error("Not implemented.");
  }

  getVocabSize() {
    return this.vocab_size;
  }

  encode(str) {
    throw new Error("Not implemented.");
  }

  decode(arr) {
    throw new Error("Not implemented.");
  }
}

class SimpleTokenizer extends Tokenizer {
  constructor() {
    super();
  }

  async load() {
    console.log("Loading simple tokenizer...");
    this.encoder = await (await fetch("models/tokenization/simple_tokens.json")).json();
    this.decoder = Object.keys(this.encoder).reduce((acc, x) => ({ ...acc, [this.encoder[x]]: x }), {});
    this.vocab_size = Object.keys(this.encoder).length;
  }

  encode(str) {
    return str.split("").map((x) => this.encoder[x]);
  }

  decode(arr) {
    return arr.map((x) => this.decoder[x]).join("");
  }
}

class GPT2Tokenizer extends Tokenizer {
  constructor() {
    super();
    this.pat = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
    this.textEncoder = new TextEncoder(); // always utf-8 by spec
    this.textDecoder = new TextDecoder("utf-8");
  }

  async load() {
    console.log("Loading GPT2 tokenizer...");

    const bpe_file = await (await fetch("models/tokenization/vocab.bpe")).text();
    const encoder = await (await fetch("models/tokenization/gpt_tokens.json")).json();
    this.encoder = encoder;

    console.log("Building decoder...");
    const decoder = {};
    Object.keys(encoder).map((x) => {
      decoder[encoder[x]] = x;
    });
    this.decoder = decoder;

    const lines = bpe_file.split("\n");
    const bpe_merges = lines.slice(1, lines.length - 1).map((x) => {
      return x.split(/(\s+)/).filter(function (e) {
        return e.trim().length > 0;
      });
    });

    const byte_encoder = bytes_to_unicode();
    const byte_decoder = {};
    Object.keys(byte_encoder).map((x) => {
      byte_decoder[byte_encoder[x]] = x;
    });
    this.byte_encoder = byte_encoder;
    this.byte_decoder = byte_decoder;

    this.bpe_ranks = dictZip(bpe_merges, range(0, bpe_merges.length));
    this.cache = new Map();
    this.vocab_size = Object.keys(encoder).length;
  }

  encode(text) {
    if (!this.byte_encoder) throw new Error("Tokenizer not loaded.");
    let bpe_tokens = [];
    const matches = Array.from(text.matchAll(this.pat)).map((x) => x[0]);
    for (let token of matches) {
      token = Array.from(this.textEncoder.encode(token))
        .map((x) => x.toString())
        .map((x) => {
          return this.byte_encoder[x];
        })
        .join("");

      const new_tokens = this.bpe(token)
        .split(" ")
        .map((x) => this.encoder[x]);
      bpe_tokens = bpe_tokens.concat(new_tokens);
    }
    return bpe_tokens;
  }

  decode(tokens) {
    if (!this.byte_decoder) throw new Error("Tokenizer not loaded.");
    let text = tokens.map((x) => this.decoder[x]).join("");
    text = this.textDecoder.decode(new Uint8Array(text.split("").map((x) => this.byte_decoder[x])));
    return text;
  }

  bpe(token) {
    if (this.cache.has(token)) return this.cache.get(token);
    let word = token.split("");
    let pairs = get_pairs(word);
    if (!pairs) return token;
    while (true) {
      const minPairs = {};
      Array.from(pairs).map((pair) => {
        const rank = this.bpe_ranks[pair];
        minPairs[isNaN(rank) ? 10e10 : rank] = pair;
      });
      const keys = Object.keys(minPairs).map((x) => parseInt(x));
      const bigram = minPairs[Math.min(...keys)];
      if (!Object.hasOwn(this.bpe_ranks, bigram)) break;
      const first = bigram[0];
      const second = bigram[1];
      let new_word = [];
      let i = 0;
      while (i < word.length) {
        const j = word.indexOf(first, i);
        if (j === -1) {
          new_word = new_word.concat(word.slice(i));
          break;
        }
        new_word = new_word.concat(word.slice(i, j));
        i = j;
        if (word[i] === first && i < word.length - 1 && word[i + 1] === second) {
          new_word.push(first + second);
          i = i + 2;
        } else {
          new_word.push(word[i]);
          i = i + 1;
        }
      }
      word = new_word;
      if (word.length === 1) break;
      else pairs = get_pairs(word);
    }
    word = word.join(" ");
    this.cache.set(token, word);
    return word;
  }
}

const range = (x, y) => {
  res = Array.from(Array(y).keys()).slice(x);
  return res;
};

const ord = (x) => {
  return x.charCodeAt(0);
};

const dictZip = (x, y) => {
  const result = {};
  x.map((_, i) => {
    result[x[i]] = y[i];
  });
  return result;
};

const bytes_to_unicode = () => {
  const bs = range(ord("!"), ord("~") + 1).concat(range(ord("¡"), ord("¬") + 1), range(ord("®"), ord("ÿ") + 1));
  let cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 2 ** 8; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(2 ** 8 + n);
      n = n + 1;
    }
  }
  cs = cs.map((x) => String.fromCharCode(x));
  const result = {};
  bs.map((_, i) => {
    result[bs[i]] = cs[i];
  });
  return result;
};

const get_pairs = (word) => {
  const pairs = new Set();
  let prev_char = word[0];
  for (let i = 1; i < word.length; i++) {
    const char = word[i];
    pairs.add([prev_char, char]);
    prev_char = char;
  }
  return pairs;
};

class Block {
  constructor() {
    this.bufferDeletionStack = [];
  }

  initialize(device) {
    this.device = device;
    this.initBindGroups();
  }

  initBindGroup(layout, buffers, label = "") {
    return this.device.createBindGroup({
      layout,
      entries: buffers.map((buffer, i) => ({
        binding: i,
        resource: { buffer },
      })),
      label,
    });
  }

  initBuffer(ops, dims) {
    const buffer = this.device.createBuffer({
      size: this.bufferSize(dims[0], dims[1] || 1, dims[2] || 1),
      usage: ops.map((u) => bufferUsageDict[u]).reduce((a, b) => a | b),
    });
    this.bufferDeletionStack.push(buffer);
    return buffer;
  }

  bufferSize(dimA, dimB = 1) {
    return Math.ceil((dimA * dimB * Float32Array.BYTES_PER_ELEMENT) / 1) * 1;
  }

  initBindGroups() {
    const bg = (types) =>
      this.device.createBindGroupLayout({
        entries: types.map((entry, i) => ({
          binding: i,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: entry },
        })),
      });

    this.r_r_r_r_Layout = bg(["read-only-storage", "read-only-storage", "read-only-storage", "read-only-storage"]);
    this.r_r_r_Layout = bg(["read-only-storage", "read-only-storage", "read-only-storage"]);
    this.r_r_Layout = bg(["read-only-storage", "read-only-storage"]);
    this.r_Layout = bg(["read-only-storage"]);
    this.u_s_Layout = bg(["uniform", "storage"]);
    this.u_s_s_s_Layout = bg(["uniform", "storage", "storage", "storage"]);
  }

  initPipeline(code, bindGroupLayouts, label = "", constants = {}) {
    return this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts }),
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: "main",
        constants,
      },
      label,
    });
  }

  destroyBuffers() {
    this.bufferDeletionStack.map((buffer) => buffer.destroy());
    this.bufferDeletionStack = [];
  }
}

class FastMatMulBlockClass extends Block {
  constructor() {
    super();
    this.name = "fastMatMul";
    this.pipelineCache = new Map();
  }

  getPipeline() {
    const pipelineCacheKey = this.name;
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const kernel = this.fastMatMul;
    const pipeline = this.initPipeline(kernel, [this.u_s_Layout, this.r_r_Layout], `${this.name}_Pipeline_${pipelineCacheKey}`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  newInstance(rows, cols, shared, bufA, bufB) {
    const pipeline = this.getPipeline();
    const uniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const resultBuffer = this.initBuffer(["storage", "copy_from"], [rows, cols]);
    const opBindGroup = this.initBindGroup(this.u_s_Layout, [uniformBuffer, resultBuffer], `${this.name}_OpG`);
    const inputBindGroup = this.initBindGroup(this.r_r_Layout, [bufA, bufB], `${this.name}_InputG`);
    const workgroups = { x: wgSize(cols, 64), y: wgSize(rows, 32) };
    this.device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([rows, cols, Math.ceil(cols / 4), Math.ceil(shared / 4)]));

    return {
      resultBuffer,
      passes: [
        {
          flag: "compute",
          pipeline,
          groups: [opBindGroup, inputBindGroup],
          workgroups,
        },
      ],
    };
  }

  fastMatMul = `
    struct CMeta {
      M: u32,
      N: u32,
      ND4: u32,
      KD4: u32,
    }

    @group(1) @binding(0) var<storage,read> array_a: array<vec4<f32>>;
    @group(1) @binding(1) var<storage,read> array_b: array<vec4<f32>>;

    @group(0) @binding(0) var<uniform> cmeta: CMeta;
    @group(0) @binding(1) var<storage,read_write> array_c: array<vec4<f32>>;

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
      var M: u32 = cmeta.M;
      var N: u32 = cmeta.N;
      var ND4: u32 = cmeta.ND4;
      var KD4: u32 = cmeta.KD4;
      var x: u32 = global_id.x;
      var y: u32 = global_id.y;

      if (x * 8 >= N || y * 4 >= M) {
        return;
      }

      var sum00: vec4<f32> = vec4<f32>();
      var sum01: vec4<f32> = vec4<f32>();
      var sum02: vec4<f32> = vec4<f32>();
      var sum03: vec4<f32> = vec4<f32>();
      var sum10: vec4<f32> = vec4<f32>();
      var sum11: vec4<f32> = vec4<f32>();
      var sum12: vec4<f32> = vec4<f32>();
      var sum13: vec4<f32> = vec4<f32>();

      for(var k: u32 = 0u; k < KD4; k = k + 1u) {
        var arow0: vec4<f32> = array_a[(y * 4u + 0u) * KD4 + k];
        var arow1: vec4<f32> = array_a[(y * 4u + 1u) * KD4 + k];
        var arow2: vec4<f32> = array_a[(y * 4u + 2u) * KD4 + k];
        var arow3: vec4<f32> = array_a[(y * 4u + 3u) * KD4 + k];
        var brow: vec4<f32>;

        brow = array_b[(k * 4u + 0u) * ND4 + x * 2u + 0u];
        sum00 = vec4<f32>(arow0.x) * brow + sum00;
        sum01 = vec4<f32>(arow1.x) * brow + sum01;
        sum02 = vec4<f32>(arow2.x) * brow + sum02;
        sum03 = vec4<f32>(arow3.x) * brow + sum03;

        brow = array_b[(k * 4u + 0u) * ND4 + x * 2u + 1u];
        sum10 = vec4<f32>(arow0.x) * brow + sum10;
        sum11 = vec4<f32>(arow1.x) * brow + sum11;
        sum12 = vec4<f32>(arow2.x) * brow + sum12;
        sum13 = vec4<f32>(arow3.x) * brow + sum13;

        brow = array_b[(k * 4u + 1u) * ND4 + x * 2u + 0u];
        sum00 = vec4<f32>(arow0.y) * brow + sum00;
        sum01 = vec4<f32>(arow1.y) * brow + sum01;
        sum02 = vec4<f32>(arow2.y) * brow + sum02;
        sum03 = vec4<f32>(arow3.y) * brow + sum03;

        brow = array_b[(k * 4u + 1u) * ND4 + x * 2u + 1u];
        sum10 = vec4<f32>(arow0.y) * brow + sum10;
        sum11 = vec4<f32>(arow1.y) * brow + sum11;
        sum12 = vec4<f32>(arow2.y) * brow + sum12;
        sum13 = vec4<f32>(arow3.y) * brow + sum13;

        brow = array_b[(k * 4u + 2u) * ND4 + x * 2u + 0u];
        sum00 = vec4<f32>(arow0.z) * brow + sum00;
        sum01 = vec4<f32>(arow1.z) * brow + sum01;
        sum02 = vec4<f32>(arow2.z) * brow + sum02;
        sum03 = vec4<f32>(arow3.z) * brow + sum03;

        brow = array_b[(k * 4u + 2u) * ND4 + x * 2u + 1u];
        sum10 = vec4<f32>(arow0.z) * brow + sum10;
        sum11 = vec4<f32>(arow1.z) * brow + sum11;
        sum12 = vec4<f32>(arow2.z) * brow + sum12;
        sum13 = vec4<f32>(arow3.z) * brow + sum13;

        brow = array_b[(k * 4u + 3u) * ND4 + x * 2u + 0u];
        sum00 = vec4<f32>(arow0.w) * brow + sum00;
        sum01 = vec4<f32>(arow1.w) * brow + sum01;
        sum02 = vec4<f32>(arow2.w) * brow + sum02;
        sum03 = vec4<f32>(arow3.w) * brow + sum03;

        brow = array_b[(k * 4u + 3u) * ND4 + x * 2u + 1u];
        sum10 = vec4<f32>(arow0.w) * brow + sum10;
        sum11 = vec4<f32>(arow1.w) * brow + sum11;
        sum12 = vec4<f32>(arow2.w) * brow + sum12;
        sum13 = vec4<f32>(arow3.w) * brow + sum13;
      }

      if (y * 4u + 0u < M) {
        array_c[x * 2u + 0u + (y * 4u + 0u) * ND4] = sum00;
        array_c[x * 2u + 1u + (y * 4u + 0u) * ND4] = sum10;
      }
      if (y * 4u + 1u < M) {
        array_c[x * 2u + 0u + (y * 4u + 1u) * ND4] = sum01;
        array_c[x * 2u + 1u + (y * 4u + 1u) * ND4] = sum11;
      }
      if (y * 4u + 2u < M) {
        array_c[x * 2u + 0u + (y * 4u + 2u) * ND4] = sum02;
        array_c[x * 2u + 1u + (y * 4u + 2u) * ND4] = sum12;
      }
      if (y * 4u + 3u < M) {
        array_c[x * 2u + 0u + (y * 4u + 3u) * ND4] = sum03;
        array_c[x * 2u + 1u + (y * 4u + 3u) * ND4] = sum13;
      }
    }
  `;
}

class ResidualBlockClass extends Block {
  constructor() {
    super();
    this.name = "residual";
    this.pipelineCache = new Map();
  }

  getPipeline() {
    const pipelineCacheKey = this.name; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.elementWiseAdditionShader, [this.u_s_Layout, this.r_r_Layout], `${this.name}_Pipeline`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  newInstance(rows, cols, outputBuf, residualBuf) {
    const pipeline = this.getPipeline();
    const uniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const resultBuffer = this.initBuffer(["storage", "copy_from"], [rows, cols]);
    const opBindGroup = this.initBindGroup(this.u_s_Layout, [uniformBuffer, resultBuffer], `${this.name}_OpG`);
    const inputBindGroup = this.initBindGroup(this.r_r_Layout, [outputBuf, residualBuf], `${this.name}_InputG`);
    const workgroups = { x: wgSize(cols, 16), y: wgSize(rows, 16), z: 1 };
    this.device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([rows, cols]));

    return {
      resultBuffer,
      passes: [
        {
          flag: "compute",
          pipeline,
          groups: [opBindGroup, inputBindGroup],
          workgroups,
        },
      ],
    };
  }

  elementWiseAdditionShader = `
    struct Matrix {
        data: array<f32>,
    }

    struct Uniforms {
      dimY: u32,
      dimX: u32,
    };

    @group(1) @binding(0) var<storage, read> LayerOutput: Matrix;
    @group(1) @binding(1) var<storage, read> Residual: Matrix;

    @group(0) @binding(0) var<uniform> dimBuffer: Uniforms;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
      let col: u32 = global_id.x;
      let row: u32 = global_id.y;
      let dimX: u32 = dimBuffer.dimX;
      let dimY: u32 = dimBuffer.dimY;

      if (row >= dimY || col >= dimX) {
        return;
      }

      Result.data[row * dimX + col] = LayerOutput.data[row * dimX + col] + Residual.data[row * dimX + col];
    }
  `;
}

class NaiveMatMulBlockClass extends Block {
  constructor() {
    super();
    this.name = "naiveMatMul";
    this.pipelineCache = new Map();
  }

  getPipeline() {
    const pipelineCacheKey = this.name; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.matMulShader, [this.u_s_Layout, this.r_r_Layout], `${this.name}_Pipeline`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  newInstance(rows, cols, shared, bufA, bufB) {
    const pipeline = this.getPipeline();
    const uniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const resultBuffer = this.initBuffer(["storage", "copy_from"], [rows, cols]);
    const opBindGroup = this.initBindGroup(this.u_s_Layout, [uniformBuffer, resultBuffer], `${this.name}_OutputG`);
    const inputBindGroup = this.initBindGroup(this.r_r_Layout, [bufA, bufB], `${this.name}_InputG`);
    const workgroups = { x: wgSize(cols, 16), y: wgSize(rows, 16), z: 1 };
    this.device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([rows, cols, shared]));

    return {
      resultBuffer,
      passes: [
        {
          flag: "compute",
          pipeline,
          groups: [opBindGroup, inputBindGroup],
          workgroups,
        },
      ],
    };
  }

  // Experimenting with preloading all weights, not too important just style.
  preloadInstance(cols, shared, bufB) {
    this.cols = cols;
    this.shared = shared;
    this.weightsBuf = bufB;

    return (newPreloadedInstance = (rows, bufA) => {
      const pipeline = this.getPipeline();
      const uniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
      const resultBuffer = this.initBuffer(["storage", "copy_from"], [rows, this.cols]);
      const opBindGroup = this.initBindGroup(this.u_s_Layout, [uniformBuffer, resultBuffer], `${this.name}_OutputG`);
      const inputBindGroup = this.initBindGroup(this.r_r_Layout, [bufA, this.weightsBuf], `${this.name}_InputG`);
      const workgroups = { x: wgSize(this.cols, 16), y: wgSize(rows, 16), z: 1 };
      this.device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([rows, this.cols, this.shared]));

      return {
        resultBuffer,
        passes: [
          {
            flag: "compute",
            pipeline,
            groups: [opBindGroup, inputBindGroup],
            workgroups,
          },
        ],
      };
    });
  }

  matMulShader = `
    struct Matrix {
        data: array<f32>,
    }

    struct Uniforms {
      dimY: u32, // row dimension of A and row dimension of C
      dimX: u32, // col dimension of B and col dimension of C
      dimS: u32, // shared dimension of A and B
    };

    @group(1) @binding(0) var<storage, read> A: Matrix;
    @group(1) @binding(1) var<storage, read> B: Matrix;

    @group(0) @binding(1) var<storage, read_write> C: Matrix;
    @group(0) @binding(0) var<uniform> dimBuffer: Uniforms;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
        let col: u32 = global_id.x;
        let row: u32 = global_id.y;
        let dimX: u32 = dimBuffer.dimX;
        let dimY: u32 = dimBuffer.dimY;
        let dimS: u32 = dimBuffer.dimS;

        if (row >= dimY || col >= dimX) {
          return;
        }

        var sum: f32 = 0.0;
        for (var i: u32 = 0; i < dimS; i = i + 1) {
            sum = sum + A.data[row * dimS + i] * B.data[i * dimX + col];
        }

        C.data[row * dimX + col] = sum;
      }
  `;
}

class TransposeBlockClass extends Block {
  constructor() {
    super();
    this.name = "transpose";
    this.pipelineCache = new Map();
  }

  getPipeline() {
    const pipelineCacheKey = this.name; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.transposeShader, [this.u_s_Layout, this.r_r_Layout], `${this.name}_Pipeline`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  newInstance(rows, cols, inputBuf) {
    const pipeline = this.getPipeline();
    const uniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const resultBuffer = this.initBuffer(["storage", "copy_from"], [rows, cols]);
    const opBindGroup = this.initBindGroup(this.u_s_Layout, [uniformBuffer, resultBuffer], `${this.name}_OpG`);
    const inputBindGroup = this.initBindGroup(this.r_r_Layout, [inputBuf], `${this.name}_InputG`);
    const workgroups = { x: wgSize(cols, 16), y: wgSize(rows, 16), z: 1 };
    this.device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([rows, cols]));

    return {
      resultBuffer,
      passes: [
        {
          flag: "compute",
          pipeline,
          groups: [opBindGroup, inputBindGroup],
          workgroups,
        },
      ],
    };
  }

  transposeShader = `
    struct Matrix {
      data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // row dimension of input matrix
      dimX: u32, // col dimension of input matrix
    };

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;

    @group(1) @binding(0) var<storage, read> Input: Matrix;

    @compute @workgroup_size(16, 16)
    fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
      let col: u32 = global_id.x;
      let row: u32 = global_id.y;
      let dimX: u32 = DimBuffer.dimX;
      let dimY: u32 = DimBuffer.dimY;

      if (row >= dimY || col >= dimX) {
        return;
      }

      Result.data[row * dimX + col] = Input.data[col * dimY + row];
    }
  `;
}

class FastRowAddBlockClass extends Block {
  constructor() {
    super();
    this.name = "fastRowAdd";
    this.pipelineCache = new Map();
  }

  getPipeline() {
    const pipelineCacheKey = this.name; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.fastRowAddShader, [this.u_s_Layout, this.r_r_Layout], `${this.name}_Pipeline`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  newInstance(rows, cols, inputBuf, rowBuf) {
    if (cols % 4 !== 0) throw new Error(`cols must be a multiple of 4, got ${rows}x${cols}`);

    const pipeline = this.getPipeline();
    const uniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const resultBuffer = this.initBuffer(["storage", "copy_from"], [rows, cols]);
    const opBindGroup = this.initBindGroup(this.u_s_Layout, [uniformBuffer, resultBuffer], `${this.name}_OpG`);
    const inputBindGroup = this.initBindGroup(this.r_r_Layout, [inputBuf, rowBuf], `${this.name}_InputG`);
    const workgroups = { x: wgSize(cols, 32), y: wgSize(rows, 8), z: 1 };
    this.device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([rows, cols, cols / 4]));

    return {
      resultBuffer,
      passes: [
        {
          flag: "compute",
          pipeline,
          groups: [opBindGroup, inputBindGroup],
          workgroups,
        },
      ],
    };
  }

  fastRowAddShader = `
    struct BMeta {
      M: u32,
      N: u32,
      ND4: u32,
    }

    @group(1) @binding(0) var<storage,read> array_matrix: array<vec4<f32>>;
    @group(1) @binding(1) var<storage,read> array_bias: array<vec4<f32>>;
    @group(0) @binding(0) var<uniform> bmeta: BMeta;
    @group(0) @binding(1) var<storage,read_write> array_output: array<vec4<f32>>;

    @compute @workgroup_size(8,8)
    fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
      var col: u32 = global_id.x;
      var row: u32 = global_id.y;
      var ND4: u32 = bmeta.ND4;
      var M: u32 = bmeta.M;
      
      if (row >= M || col >= ND4) {
        return;
      }

      array_output[row * ND4 + col] = array_matrix[row * ND4 + col] + array_bias[col];
    }
  `;
}

class LayerNormBlockClass extends Block {
  constructor() {
    super();
    this.name = "layerNorm";
    this.pipelineCache = new Map();
  }

  getStatsPipeline() {
    const pipelineCacheKey = `${this.name}_stats`; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.normStatsShader, [this.u_s_Layout, this.r_Layout], `${this.name}_Pipeline_Stats`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  getNormPipeline() {
    const pipelineCacheKey = `${this.name}_norm`; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.normShader, [this.u_s_Layout, this.r_r_r_r_Layout], `${this.name}_Pipeline_Norm`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  newInstance(rows, cols, inputBuffer, gammaBuffer, betaBuffer) {
    const statsPipeline = this.getStatsPipeline();
    const statsUniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const statsResultBuffer = this.initBuffer(["storage", "copy_from"], [rows, 2]);
    const statsBindGroup = this.initBindGroup(this.u_s_Layout, [statsUniformBuffer, statsResultBuffer], `${this.name}_BindGroup_stats`);
    const statsInputBindGroup = this.initBindGroup(this.r_Layout, [inputBuffer], `${this.name}_InputG`);
    const statsWorkgroups = { x: wgSize(cols, 16), y: 1, z: 1 };
    this.device.queue.writeBuffer(statsUniformBuffer, 0, new Uint32Array([rows, cols]));

    const normPipeline = this.getNormPipeline();
    const normUniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const normResultBuffer = this.initBuffer(["storage", "copy_from"], [rows, cols]);
    const normBindGroup = this.initBindGroup(this.u_s_Layout, [normUniformBuffer, normResultBuffer], `${this.name}_BindGroup_norm`);
    const normInputBindGroup = this.initBindGroup(
      this.r_r_r_r_Layout,
      [inputBuffer, gammaBuffer, betaBuffer, statsResultBuffer],
      `${this.name}_InputBindGroup_norm`
    );
    this.device.queue.writeBuffer(normUniformBuffer, 0, new Uint32Array([rows, cols]));
    const normWorkgroups = { x: wgSize(cols, 16), y: wgSize(rows, 16), z: 1 };

    return {
      resultBuffer: normResultBuffer,
      passes: [
        {
          flag: "compute",
          pipeline: statsPipeline,
          groups: [statsBindGroup, statsInputBindGroup],
          workgroups: statsWorkgroups,
        },
        {
          flag: "compute",
          pipeline: normPipeline,
          groups: [normBindGroup, normInputBindGroup],
          workgroups: normWorkgroups,
        },
      ],
    };
  }

  normStatsShader = `
    struct Matrix {
      data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // row dimension
      dimX: u32, // col dimension
    };

    @group(1) @binding(0) var<storage, read> Input: Matrix;

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;

    @compute @workgroup_size(16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
      let row: u32 = global_id.x;
      let dimX: u32 = DimBuffer.dimX;

      if (row >= DimBuffer.dimY) {
        return;
      }

      var sum: f32 = 0.0;
      for (var i: u32 = 0; i < dimX; i = i + 1) {
          sum = sum + Input.data[row * dimX + i];
      }
      var mean: f32 = sum / f32(dimX);

      var variance: f32 = 0.0;
      for (var i: u32 = 0; i < dimX; i = i + 1) {
          variance = variance + (Input.data[row * dimX + i] - mean) * (Input.data[row * dimX + i] - mean);
      }
      variance = variance / f32(dimX);
      var stdev: f32 = sqrt(variance + 1e-5);

      Result.data[row * 2] = mean;
      Result.data[row * 2 + 1] = stdev;
    }
  `;

  normShader = `
    struct Matrix {
        data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // row dimension of input matrix
      dimX: u32, // col dimension of input matrix
    };

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;

    @group(1) @binding(0) var<storage, read> Input: Matrix;
    @group(1) @binding(1) var<storage, read> Gamma: Matrix;
    @group(1) @binding(2) var<storage, read> Beta: Matrix;
    @group(1) @binding(3) var<storage, read> Stats: Matrix;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
      let col: u32 = global_id.x;
      let row: u32 = global_id.y;
      let dimX: u32 = DimBuffer.dimX;
      let dimY: u32 = DimBuffer.dimY;

      if (row >= dimY || col >= dimX) {
        return;
      }

      let mean = Stats.data[row * 2];
      let stdev = Stats.data[row * 2 + 1];
      let output = (Input.data[row * dimX + col] - mean) / stdev;
      let gamma = Gamma.data[col];
      let beta = Beta.data[col];
      let shift = gamma * output + beta;
      Result.data[row * dimX + col] = shift;
    }
  `;
}

class SoftmaxBlockClass extends Block {
  constructor() {
    super();
    this.name = "Softmax";
    this.pipelineCache = new Map();
  }

  getMaxPipeline() {
    const pipelineCacheKey = `${this.name}_max`; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.maskedNegMaxShader, [this.u_s_Layout, this.r_Layout], `${this.name}_Pipeline_Max`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  getAddPipeline() {
    const pipelineCacheKey = `${this.name}_add`; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.addExpShader, [this.u_s_Layout, this.r_r_Layout], `${this.name}_Pipeline_Add`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  getSumPipeline() {
    const pipelineCacheKey = `${this.name}_sum`; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.sumShader, [this.u_s_Layout, this.r_Layout], `${this.name}_Pipeline_Sum`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  getDivPipeline() {
    const pipelineCacheKey = `${this.name}_div`; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.divideShader, [this.u_s_Layout, this.r_r_Layout], `${this.name}_Pipeline_Div`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  newInstance(rows, cols, inputBuffer) {
    const uniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);

    const maxPipeline = this.getMaxPipeline();
    const maxResultBuffer = this.initBuffer(["storage", "copy_from"], [rows]);
    const maxBindGroup = this.initBindGroup(this.u_s_Layout, [uniformBuffer, maxResultBuffer], `${this.name}_BindGroup_Max`);
    const maxInputBindGroup = this.initBindGroup(this.r_Layout, [inputBuffer], `${this.name}_BindGroup_Max_Input`);
    const maxWorkgroups = { x: wgSize(rows, 16), y: 1, z: 1 };

    const addPipeline = this.getAddPipeline();
    const addExpResultBuffer = this.initBuffer(["storage", "copy_from"], [rows, cols]);
    const addExpBindGroup = this.initBindGroup(this.u_s_Layout, [uniformBuffer, addExpResultBuffer], `${this.name}_BindGroup_Add`);
    const addExpInputBindGroup = this.initBindGroup(this.r_r_Layout, [inputBuffer, maxResultBuffer], `${this.name}_BindGroup_Add_Input`);
    const addExpWorkgroups = { x: wgSize(cols, 16), y: wgSize(rows, 16), z: 1 };

    const sumPipeline = this.getSumPipeline();
    const sumResultBuffer = this.initBuffer(["storage", "copy_from"], [rows]);
    const sumBindGroup = this.initBindGroup(this.u_s_Layout, [uniformBuffer, sumResultBuffer], `${this.name}_BindGroup_Sum`);
    const sumInputBindGroup = this.initBindGroup(this.r_Layout, [addExpResultBuffer]);
    const sumWorkgroups = { x: wgSize(rows, 16), y: 1, z: 1 };

    const divResultPipeline = this.getDivPipeline();
    const divResultBuffer = this.initBuffer(["storage", "copy_from"], [rows, cols], `${this.name}_ResultBuffer_Div`);
    const divBindGroup = this.initBindGroup(this.u_s_Layout, [uniformBuffer, divResultBuffer], `${this.name}_BindGroup_Div`);
    const divInputBindGroup = this.initBindGroup(this.r_r_Layout, [addExpResultBuffer, sumResultBuffer], `${this.name}_BindGroup_Div_Input`);
    const divWorkgroups = { x: wgSize(cols, 16), y: wgSize(rows, 16), z: 1 };

    this.device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([rows, cols]));

    return {
      resultBuffer: divResultBuffer,
      passes: [
        {
          flag: "compute",
          pipeline: maxPipeline,
          groups: [maxBindGroup, maxInputBindGroup],
          workgroups: maxWorkgroups,
        },
        {
          flag: "compute",
          pipeline: addPipeline,
          groups: [addExpBindGroup, addExpInputBindGroup],
          workgroups: addExpWorkgroups,
        },
        {
          flag: "compute",
          pipeline: sumPipeline,
          groups: [sumBindGroup, sumInputBindGroup],
          workgroups: sumWorkgroups,
        },
        {
          flag: "compute",
          pipeline: divResultPipeline,
          groups: [divBindGroup, divInputBindGroup],
          workgroups: divWorkgroups,
        },
      ],
    };
  }

  maskedNegMaxShader = `
    struct Matrix {
      data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // row dimension
      dimX: u32, // col dimension
    };

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;
    @group(1) @binding(0) var<storage, read> Input: Matrix;

    @compute @workgroup_size(16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
      let row: u32 = global_id.x;
      let dimX: u32 = DimBuffer.dimX;

      if (row >= DimBuffer.dimY) {
        return;
      }

      let rowMask: u32 = row % dimX;

      var max_buffer: f32 = 0.0;
      for (var i: u32 = 0; i < rowMask; i = i + 1) {
        max_buffer = max(max_buffer, Input.data[row * dimX + i]);
      }

      Result.data[row] = -max_buffer;
    }
  `;

  addExpShader = `
    struct Matrix {
        data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // row dimension of input matrix
      dimX: u32, // col dimension of input matrix
    };

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;
    @group(1) @binding(0) var<storage, read> Input: Matrix;
    @group(1) @binding(1) var<storage, read> Constants: Matrix;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
      let col: u32 = global_id.x;
      let row: u32 = global_id.y;
      let dimX: u32 = DimBuffer.dimX;
      let dimY: u32 = DimBuffer.dimY;

      let rowMask: u32 = row % dimX;

      if (row >= dimY || col > rowMask) {
        return;
      }

      Result.data[row * dimX + col] = exp(Input.data[row * dimX + col] + Constants.data[row]);
    }
  `;

  sumShader = `
    struct Matrix {
      data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // row dimension
      dimX: u32, // col dimension
    };

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;
    @group(1) @binding(0) var<storage, read> Input: Matrix;

    @compute @workgroup_size(16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
      let row: u32 = global_id.x;
      let dimX: u32 = DimBuffer.dimX;

      if (row >= DimBuffer.dimY) {
        return;
      }

      var sum: f32 = 0.0;
      for (var i: u32 = 0; i < dimX; i = i + 1) {
          sum = sum + Input.data[row * dimX + i];
      }

      Result.data[row] = sum;
    }
  `;

  divideShader = `
    struct Matrix {
        data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // row dimension of input matrix
      dimX: u32, // col dimension of input matrix
    };

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;
    @group(1) @binding(0) var<storage, read> Input: Matrix;
    @group(1) @binding(1) var<storage, read> Divisors: Matrix;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
        let col: u32 = global_id.x;
        let row: u32 = global_id.y;
        let dimX: u32 = DimBuffer.dimX;
        let dimY: u32 = DimBuffer.dimY;

        if (row >= dimY || col >= dimX) {
          return;
        }

        Result.data[row * dimX + col] = Input.data[row * dimX + col] / Divisors.data[row];
      }
  `;
}

class GeluBlockClass extends Block {
  constructor() {
    super();
    this.name = "gelu";
    this.pipelineCache = new Map();
  }

  getPipeline() {
    const pipelineCacheKey = this.name; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.GELUShader, [this.u_s_Layout, this.r_Layout], `${this.name}_Pipeline`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  newInstance(rows, cols, inputBuf) {
    const pipeline = this.getPipeline();
    const uniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const resultBuffer = this.initBuffer(["storage", "copy_from"], [rows, cols]);
    const opBindGroup = this.initBindGroup(this.u_s_Layout, [uniformBuffer, resultBuffer], `${this.name}_OpG`);
    const inputBindGroup = this.initBindGroup(this.r_Layout, [inputBuf], `${this.name}_InputG`);
    const workgroups = { x: wgSize(cols, 16), y: wgSize(rows, 16), z: 1 };
    this.device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([rows, cols]));

    return {
      resultBuffer,
      passes: [
        {
          flag: "compute",
          pipeline,
          groups: [opBindGroup, inputBindGroup],
          workgroups,
        },
      ],
    };
  }

  GELUShader = `
    struct Matrix {
        data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // row dimension of input matrix
      dimX: u32, // col dimension of input matrix
    };

    const SQRPI: f32 = 0.7978845608;
    fn gelu(x: f32) -> f32 {
      if (x < -10.0) {
        return 0.0;
      } else if (x > 10.0) {
        return x;
      } else {
        let cdf_approx: f32 = 0.5 * (1.0 + tanh(SQRPI * (x + 0.044715 * pow(x, 3))));
        return x * cdf_approx;
      }
    }

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;

    @group(1) @binding(0) var<storage, read> Input: Matrix;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
      let col: u32 = global_id.x;
      let row: u32 = global_id.y;
      let dimX: u32 = DimBuffer.dimX;
      let dimY: u32 = DimBuffer.dimY;

      if (row >= dimY || col >= dimX) {
        return;
      }

      Result.data[row * dimX + col] = gelu(Input.data[row * dimX + col]);
    }
  `;
}

class AttentionBlockClass extends Block {
  constructor() {
    super();
    this.name = "attention";
    this.pipelineCache = new Map();
  }

  getSplitQKVPipeline() {
    const pipelineCacheKey = `${this.name}_splitkqv`; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.splitQKVShader, [this.u_s_s_s_Layout, this.r_Layout], `${this.name}_Pipeline_SplitQKV`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  getAttentionWeightsPipeline() {
    const pipelineCacheKey = `${this.name}_weights`; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.attentionWeightsShader, [this.u_s_Layout, this.r_r_Layout], `${this.name}_Pipeline_AttWeights`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  getMultiplyPipeline() {
    const pipelineCacheKey = `${this.name}_multiply`; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.multiplyShader, [this.u_s_Layout, this.r_Layout], `${this.name}_Pipeline_Mult`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  getCausalMaskPipeline() {
    const pipelineCacheKey = `${this.name}_causalmask`; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.simpleCausalMaskShader, [this.u_s_Layout, this.r_Layout], `${this.name}_Pipeline_CausalMask`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  getAttentionValuesPipeline() {
    const pipelineCacheKey = `${this.name}_values`; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.attentionValuesShader, [this.u_s_Layout, this.r_r_Layout], `${this.name}_Pipeline_AttValues`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  newInstance(
    seq_length,
    n_embd,
    attentionDotProductScale,
    n_head,
    inputBuffer,
    qkvWeightsBuffer,
    qkvBiasBuffer,
    linearWeightsBuffer,
    linearBiasBuffer,
    FastMatMulBlock,
    FastRowAddBlock,
    SoftmaxBlock
  ) {
    const { resultBuffer: qkvMatMulResult, passes: qkvMatMulPasses } = FastMatMulBlock.newInstance(
      seq_length,
      3 * n_embd,
      n_embd,
      inputBuffer,
      qkvWeightsBuffer
    );
    const { resultBuffer: qkvBiasAddResult, passes: qkvBiasAddPasses } = FastRowAddBlock.newInstance(seq_length, 3 * n_embd, qkvMatMulResult, qkvBiasBuffer);

    const splitQKVPipeline = this.getSplitQKVPipeline();
    const splitQKVUniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const splitQResultBuffer = this.initBuffer(["storage", "copy_from"], [seq_length, n_embd]);
    const splitKResultBuffer = this.initBuffer(["storage", "copy_from"], [seq_length, n_embd]);
    const splitVResultBuffer = this.initBuffer(["storage", "copy_from"], [seq_length, n_embd]);
    const splitQKVBindGroup = this.initBindGroup(
      this.u_s_s_s_Layout,
      [splitQKVUniformBuffer, splitQResultBuffer, splitKResultBuffer, splitVResultBuffer],
      `${this.name}_SplitQKVG`
    );
    const splitQKVInputBindGroup = this.initBindGroup(this.r_Layout, [qkvBiasAddResult], `${this.name}_SplitQKVInputG`);
    this.device.queue.writeBuffer(splitQKVUniformBuffer, 0, new Uint32Array([seq_length, n_embd]));
    const splitQKVWorkgroups = { x: wgSize(n_embd, 16), y: wgSize(seq_length, 16), z: 1 };

    const attentionWeightsPipeline = this.getAttentionWeightsPipeline();
    const attentionWeightsUniformBuffer = this.initBuffer(["uniform", "copy_to"], [8]);
    const attentionWeightsResultBuffer = this.initBuffer(["storage", "copy_from"], [seq_length, seq_length * n_head]);
    const attentionWeightsBindGroup = this.initBindGroup(
      this.u_s_Layout,
      [attentionWeightsUniformBuffer, attentionWeightsResultBuffer],
      `${this.name}_AttentionWeightsG`
    );
    const attentionWeightsInputBindGroup = this.initBindGroup(this.r_r_Layout, [splitQResultBuffer, splitKResultBuffer], `${this.name}_AttentionWeightsInputG`);
    this.device.queue.writeBuffer(attentionWeightsUniformBuffer, 0, new Uint32Array([seq_length, seq_length * n_head, seq_length, n_embd / n_head, n_embd]));
    const attentionWeightsWorkgroups = { x: wgSize(seq_length * n_head, 16), y: wgSize(seq_length, 16), z: 1 };

    const multiplyPipeline = this.getMultiplyPipeline();
    const multiplyUniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const multiplyResultBuffer = this.initBuffer(["storage", "copy_from"], [seq_length, seq_length * n_head]);
    const multiplyBindGroup = this.initBindGroup(this.u_s_Layout, [multiplyUniformBuffer, multiplyResultBuffer]);
    const multiplyInputBindGroup = this.initBindGroup(this.r_Layout, [attentionWeightsResultBuffer], `${this.name}_MultiplyInputG`);
    this.device.queue.writeBuffer(multiplyUniformBuffer, 0, new Uint32Array([seq_length, seq_length * n_head]));
    this.device.queue.writeBuffer(multiplyUniformBuffer, 8, new Float32Array([attentionDotProductScale]));
    const multiplyWorkgroups = { x: wgSize(seq_length * n_head, 16), y: wgSize(seq_length, 16), z: 1 };

    const causalMaskPipeline = this.getCausalMaskPipeline();
    const causalMaskUniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const causalMaskResultBuffer = this.initBuffer(["storage", "copy_from"], [seq_length, seq_length * n_head]);
    const causalMaskBindGroup = this.initBindGroup(this.u_s_Layout, [causalMaskUniformBuffer, causalMaskResultBuffer], `${this.name}_CausalMaskG`);
    const causalMaskInputBindGroup = this.initBindGroup(this.r_Layout, [multiplyResultBuffer], `${this.name}_CausalMaskInputG`);
    this.device.queue.writeBuffer(causalMaskUniformBuffer, 0, new Uint32Array([seq_length * n_head, seq_length])); // Transposes! This is needed for softmax.
    const causalMaskWorkgroups = { x: wgSize(seq_length, 16), y: wgSize(seq_length * n_head, 16), z: 1 };

    const { resultBuffer: softmaxOutputBuffer, passes: softmaxPasses } = SoftmaxBlock.newInstance(seq_length * n_head, seq_length, causalMaskResultBuffer);

    const attentionValuesPipeline = this.getAttentionValuesPipeline();
    const attentionValuesUniformBuffer = this.initBuffer(["uniform", "copy_to"], [4]);
    const attentionValuesResultBuffer = this.initBuffer(["storage", "copy_from"], [seq_length, n_embd]);
    const attentionValuesBindGroup = this.initBindGroup(this.u_s_Layout, [attentionValuesUniformBuffer, attentionValuesResultBuffer]);
    const attentionValuesInputBindGroup = this.initBindGroup(this.r_r_Layout, [softmaxOutputBuffer, splitVResultBuffer], `${this.name}_AttentionValuesInputG`);
    this.device.queue.writeBuffer(attentionValuesUniformBuffer, 0, new Uint32Array([seq_length, n_embd, n_head, n_embd / n_head]));
    const attentionValuesWorkgroups = { x: wgSize(n_embd, 16), y: wgSize(seq_length, 16), z: 1 };

    const { resultBuffer: linearMatmulResult, passes: linearMatmulPasses } = FastMatMulBlock.newInstance(
      seq_length,
      n_embd,
      n_embd,
      attentionValuesResultBuffer,
      linearWeightsBuffer
    );
    const { resultBuffer: linearBiasResult, passes: linearBiasPasses } = FastRowAddBlock.newInstance(seq_length, n_embd, linearMatmulResult, linearBiasBuffer);

    return {
      resultBuffer: linearBiasResult,
      passes: [
        ...qkvMatMulPasses,
        ...qkvBiasAddPasses,
        {
          flag: "compute",
          pipeline: splitQKVPipeline,
          groups: [splitQKVBindGroup, splitQKVInputBindGroup],
          workgroups: splitQKVWorkgroups,
        },
        {
          flag: "compute",
          pipeline: attentionWeightsPipeline,
          groups: [attentionWeightsBindGroup, attentionWeightsInputBindGroup],
          workgroups: attentionWeightsWorkgroups,
        },
        {
          flag: "compute",
          pipeline: multiplyPipeline,
          groups: [multiplyBindGroup, multiplyInputBindGroup],
          workgroups: multiplyWorkgroups,
        },
        {
          flag: "compute",
          pipeline: causalMaskPipeline,
          groups: [causalMaskBindGroup, causalMaskInputBindGroup],
          workgroups: causalMaskWorkgroups,
        },
        ...softmaxPasses,
        {
          flag: "compute",
          pipeline: attentionValuesPipeline,
          groups: [attentionValuesBindGroup, attentionValuesInputBindGroup],
          workgroups: attentionValuesWorkgroups,
        },
        ...linearMatmulPasses,
        ...linearBiasPasses,
      ],
    };
  }

  splitQKVShader = `
    struct Matrix {
      data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // row dimension of Q, K, V
      dimX: u32, // col dimension of Q, K, V
    };

    @group(1) @binding(0) var<storage, read> Input: Matrix;

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Q: Matrix;
    @group(0) @binding(2) var<storage, read_write> K: Matrix;
    @group(0) @binding(3) var<storage, read_write> V: Matrix;


    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
      let col: u32 = global_id.x;
      let row: u32 = global_id.y;
      let dimX: u32 = DimBuffer.dimX;
      let dimY: u32 = DimBuffer.dimY;

      if (row >= dimY || col >= dimX) {
        return;
      }

      Q.data[row * dimX + col] = Input.data[row * dimX * 3 + col];
      K.data[row * dimX + col] = Input.data[row * dimX * 3 + dimX + col];
      V.data[row * dimX + col] = Input.data[row * dimX * 3 + 2 * dimX + col];

    }
  `;

  attentionWeightsShader = `
    struct Matrix {
      data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // output row dim, Q row dim
      dimX: u32, // output col dim, seq_length * heads
      seqLength: u32, // seq_length or K col dim (Q can be different)
      qkvCols: u32, // head col dim for Q, K or n_embd / n_heads
      embedDim: u32, // n_embd or total Q col dim & K row dim
    };

    @group(1) @binding(0) var<storage, read> Queries: Matrix;
    @group(1) @binding(1) var<storage, read> Keys: Matrix;

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
      let col: u32 = global_id.x;
      let row: u32 = global_id.y;
      let dimY: u32 = DimBuffer.dimY;
      let dimX: u32 = DimBuffer.dimX;
      let seqLength: u32 = DimBuffer.seqLength;
      let qkvCols: u32 = DimBuffer.qkvCols;
      let embedDim: u32 = DimBuffer.embedDim;

      if (row >= dimY || col >= dimX) {
        return;
      }

      var head: u32 = col / seqLength;
      var col_r: u32 = col % seqLength;
      var sum: f32 = 0.0;
      for (var i: u32 = 0; i < qkvCols; i = i + 1) {
          sum = sum + Queries.data[row * embedDim + i + head * qkvCols] * Keys.data[col_r * embedDim + i + head * qkvCols];
      }

      Result.data[row * dimX + col] = sum;
    }
  `;

  multiplyShader = `
    struct Matrix {
        data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // row dimension of input matrix
      dimX: u32, // col dimension of input matrix
      attentionScale: f32,
    };

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;

    @group(1) @binding(0) var<storage, read> Input: Matrix;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
        let col: u32 = global_id.x;
        let row: u32 = global_id.y;
        let dimX: u32 = DimBuffer.dimX;

        if (row >= DimBuffer.dimY || col >= dimX) {
          return;
        }

        Result.data[row * dimX + col] = Input.data[row * dimX + col] * DimBuffer.attentionScale;
      }
  `;

  simpleCausalMaskShader = `
    struct Matrix {
        data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // row dimension of input matrix
      dimX: u32, // col dimension of input matrix
    };

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;

    @group(1) @binding(0) var<storage, read> Input: Matrix;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
      let col: u32 = global_id.x;
      let row: u32 = global_id.y;
      let dimX: u32 = DimBuffer.dimX;
      let dimY: u32 = DimBuffer.dimY;

      let rowMask: u32 = row % dimX;
      if (row >= dimY || col > rowMask) {
        return;
      }

      let rowNum: u32 = row / dimX;
      Result.data[row * dimX + col] = Input.data[rowMask * dimY + col + rowNum * dimX];

    }
  `;

  attentionValuesShader = `
    struct Matrix {
      data: array<f32>,
    }

    struct Dimensions {
      dimY: u32, // Values row and col dimension, Weights row dimension (context)
      dimX: u32, // Result col dim (n_embd)
      numHeads: u32, // number of heads
      vCols: u32, // col dim of V
    };

    @group(1) @binding(0) var<storage, read> Weights: Matrix;
    @group(1) @binding(1) var<storage, read> Values: Matrix;

    @group(0) @binding(0) var<uniform> DimBuffer: Dimensions;
    @group(0) @binding(1) var<storage, read_write> Result: Matrix;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
      let col: u32 = global_id.x;
      let row: u32 = global_id.y;
      let dimY: u32 = DimBuffer.dimY;
      let dimX: u32 = DimBuffer.dimX;
      let vCols: u32 = DimBuffer.vCols;

      if (row >= dimY || col >= dimX) {
        return;
      }

      var head: u32 = col / vCols;
      var col_r: u32 = col % dimY;
      var sum: f32 = 0.0;
      for (var i: u32 = 0; i < dimY; i = i + 1) {
          sum = sum +  Values.data[i * dimX + col] * Weights.data[row * dimY + i + head * dimY * dimY];
      }

      Result.data[row * dimX + col] = sum;
    }
  `;
}

class EmbedBlockClass extends Block {
  constructor() {
    super();
    this.name = "embed";
    this.pipelineCache = new Map();
  }

  newInstance(idx, seq_length, n_embd, embdBuffer, posEmbdBuffer, ResidualBlock) {
    const embdOutputBuffer = this.initBuffer(["storage", "copy_to"], [seq_length, n_embd]);
    const posEmbdOutputBuffer = this.initBuffer(["storage", "copy_to"], [seq_length, n_embd]);

    // Can build a cache later.
    const embdCopyCommands = Array(seq_length)
      .fill()
      .map((_, i) => {
        return {
          flag: "copy",
          src: embdBuffer,
          srcOffset: this.bufferSize(n_embd) * idx[i],
          dst: embdOutputBuffer,
          dstOffset: this.bufferSize(n_embd) * i,
          size: this.bufferSize(n_embd),
        };
      });

    // Also can be cached.
    const posCopyCommand = {
      flag: "copy",
      src: posEmbdBuffer,
      srcOffset: 0,
      dst: posEmbdOutputBuffer,
      dstOffset: 0,
      size: this.bufferSize(seq_length, n_embd),
    };

    const { resultBuffer: residualResult, passes: residualPasses } = ResidualBlock.newInstance(seq_length, n_embd, embdOutputBuffer, posEmbdOutputBuffer);

    return {
      resultBuffer: residualResult,
      passes: [...embdCopyCommands, posCopyCommand, ...residualPasses],
    };
  }
}

class OldDeEmbedBlockClass extends Block {
  constructor() {
    super();
    this.name = "deembed";
    this.pipelineCache = new Map();
  }

  getPipeline() {
    const pipelineCacheKey = this.name; // No param optimization.
    if (this.pipelineCache.has(pipelineCacheKey)) return this.pipelineCache.get(pipelineCacheKey);
    const pipeline = this.initPipeline(this.deEmbedShader, [this.u_s_Layout, this.r_r_Layout], `${this.name}_Pipeline`);
    this.pipelineCache.set(pipelineCacheKey, pipeline);
    return pipeline;
  }

  newInstance(vocab_size, n_embd, seq_length, embedBuffer, embeddingWeightsBuffer, NaiveMatMulBlock) {
    const slicedEmbedOutputBuffer = this.initBuffer(["storage", "copy_to"], [n_embd]);
    const deEmbedOutputBuffer = this.initBuffer(["map_read", "copy_to"], [vocab_size]);

    // Assumes that vocab_size has a decent least prime factor.
    const maxStorageBufferSize = this.device.limits.maxStorageBufferBindingSize;
    const totalElements = this.bufferSize(vocab_size, n_embd);
    var numInstances = Math.ceil(totalElements / maxStorageBufferSize);
    if (numInstances > 1) numInstances = leastPrimeFactor(vocab_size, numInstances);
    var vocabChunkSize = vocab_size / numInstances;

    const chunkBuffers = Array(numInstances)
      .fill()
      .map((_, i) => {
        return this.initBuffer(["storage", "copy_to"], [n_embd, vocabChunkSize]);
      });

    const sliceEmbedCopyCommand = {
      flag: "copy",
      src: embedBuffer,
      srcOffset: this.bufferSize(seq_length - 1, n_embd),
      dst: slicedEmbedOutputBuffer,
      dstOffset: 0,
      size: this.bufferSize(1, n_embd),
    };

    const deEmbedPasses = chunkBuffers.flatMap((buffer, i) => {
      const { resultBuffer: matmulResult, passes: matmulPasses } = NaiveMatMulBlock.newInstance(vocabChunkSize, 1, n_embd, buffer, slicedEmbedOutputBuffer);
      // We're doing some buffer tricks here. Since slicedEmbedOutputBuffer is a row matrix, we can just pretend it's a column matrix without any changes to the way it's stored. We then multiply it by the transposed embeddingWeights chunk, resulting in a column vector which, once again, we can pretend is a row vector.

      return [
        {
          flag: "copy",
          src: embeddingWeightsBuffer,
          srcOffset: i * this.bufferSize(n_embd * vocabChunkSize),
          dst: buffer,
          dstOffset: 0,
          size: this.bufferSize(n_embd, vocabChunkSize),
        },
        ...matmulPasses,
        {
          flag: "copy",
          src: matmulResult,
          srcOffset: 0,
          dst: deEmbedOutputBuffer,
          dstOffset: i * this.bufferSize(vocabChunkSize),
          size: this.bufferSize(vocabChunkSize),
        },
      ];
    });

    return {
      resultBuffer: deEmbedOutputBuffer,
      passes: [sliceEmbedCopyCommand, ...deEmbedPasses],
    };
  }

  deEmbedShader = `
    struct BMeta {
      M: u32,
      N: u32,
      ND4: u32,
    }

    @group(1) @binding(0) var<storage,read> array_matrix: array<vec4<f32>>;
    @group(1) @binding(1) var<storage,read> embed_row: array<vec4<f32>>;
    @group(0) @binding(0) var<uniform> bmeta: BMeta;
    @group(0) @binding(1) var<storage,read_write> array_output: array<vec4<f32>>;

    @compute @workgroup_size(8,8)
    fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
      var row: u32 = global_id.x;
      var ND4: u32 = bmeta.ND4;
      var M: u32 = bmeta.M;
      
      if (row >= M) {
        return;
      }

      var sum00: vec4<f32> = vec4<f32>(0.0);

      for (var i: u32 = 0u; i < ND4; i = i + 1u) {
        var embedChunk = embed_row[i]
        var brow: vec4<f32>;

        brow = array_matrix[(i + 0u) * ND4 + row];
        sum00 = sum00 + vec4<f32>(embedChunk.x) * matrixChunk;

        brow = array_matrix[row * ND4 + i];
        sum00 = sum00 + vec4<f32>(embedChunk.y) * matrixChunk;

        brow = array_matrix[row * ND4 + i];
        sum00 = sum00 + vec4<f32>(embedChunk.z) * matrixChunk;

        brow = array_matrix[row * ND4 + i];
        sum00 = sum00 + vec4<f32>(embedChunk.w) * matrixChunk;
      }

      array_output[row] = sum00;
    }
  `;
}

class FastFFNBlockClass extends Block {
  constructor() {
    super();
    this.name = "fastffn";
    this.pipelineCache = new Map();
  }

  newInstance(
    seq_length,
    n_embd,
    hidden_size,
    inputBuffer,
    firstLayerWeightsBuffer,
    firstLayerBiasBuffer,
    secondLayerWeightsBuffer,
    secondLayerBiasBuffer,
    FastMatMulBlock,
    FastRowAddBlock,
    GeluBlock
  ) {
    const { resultBuffer: firstMatmulResult, passes: firstMatmulPasses } = FastMatMulBlock.newInstance(
      seq_length,
      hidden_size,
      n_embd,
      inputBuffer,
      firstLayerWeightsBuffer
    );
    const { resultBuffer: firstBiasResult, passes: firstBiasPasses } = FastRowAddBlock.newInstance(
      seq_length,
      hidden_size,
      firstMatmulResult,
      firstLayerBiasBuffer
    );

    const { resultBuffer: geluResult, passes: geluPasses } = GeluBlock.newInstance(seq_length, hidden_size, firstBiasResult);

    const { resultBuffer: secondMatmulResult, passes: secondMatmulPasses } = FastMatMulBlock.newInstance(
      seq_length,
      n_embd,
      hidden_size,
      geluResult,
      secondLayerWeightsBuffer
    );
    const { resultBuffer: secondBiasResult, passes: secondBiasPasses } = FastRowAddBlock.newInstance(
      seq_length,
      n_embd,
      secondMatmulResult,
      secondLayerBiasBuffer
    );

    return {
      resultBuffer: secondBiasResult,
      passes: [...firstMatmulPasses, ...firstBiasPasses, ...geluPasses, ...secondMatmulPasses, ...secondBiasPasses],
    };
  }
}

class GPT {
  constructor(folder, type) {
    this.folder = folder;
    this.tokenizerType = type;
    this.initialized = false;

    this.device;
    this.model;
    this.tokenizer;
    this.params;
    this.minBufferOffset = 1;

    this.defaultPrompt;
    this.defaultTopK;
    this.defaultTemperature;
    this.defaultTokens;

    this.unloadDeletionStack = [];
  }

  async initialize() {
    if (this.initialized) return console.error("Model already initialized");
    if (!navigator.gpu) throw new Error("WebGPU is not supported");

    const adapter = await navigator.gpu.requestAdapter();
    this.device = await adapter.requestDevice();

    initializeOperations(this.device);

    [this.model, this.params] = await this.loadModel(this.folder);
    this.tokenizer = this.tokenizerType == "bpe" ? new GPT2Tokenizer() : new SimpleTokenizer();
    await this.tokenizer.load();

    if (this.params.n_embd % 4 !== 0 || this.params.n_head % 4 !== 0) {
      throw new Error("Model incompatible. n_embd and n_head must be divisible by 4 for fast matmul.");
    }

    if (this.folder == "gpt2") {
      this.defaultPrompt = `What is the answer to life, the universe, and everything?\n`;
      this.defaultTopK = 3;
      this.defaultTemperature = 1;
      this.defaultTokens = 30;
    } else {
      this.defaultPrompt = `WILL:\nAh, how dare you challenge me?\nHave you forgotten I built WebGPT?\n`;
      this.defaultTopK = 1;
      this.defaultTemperature = 1;
      this.defaultTokens = 80;
    }

    this.initialized = true;

    console.log("Model initialized");
  }

  async *generate(prompt, max_new_tokens, top_k, temperature) {
    if (!this.initialized) {
      console.error("Model not loaded yet");
      return;
    }

    let history = this.tokenizer.encode(prompt);
    console.log(`Prompt (${history.length} tokens):\n${prompt}`);

    let totalTime = 0;

    for (let i = 0; i < max_new_tokens; i++) {
      const idx_cond = history.slice(-this.params.block_size);
      const useAttCache = i !== 0 && history.length <= this.params.block_size && this.doAttentionCache;

      const startTime = performance.now();
      const logits = await this.run(idx_cond, useAttCache);
      const endTime = performance.now();

      console.log(`\nIteration ${i + 1} of ${max_new_tokens}`);
      console.log(`Using attention cache? ${useAttCache}`);
      console.log(`Kernel execution time: ${endTime - startTime} ms`);
      totalTime += endTime - startTime;

      const { topKIndices, topKProbs } = selectTopK(logits, top_k);
      const probs = cpuSoftmax(topKProbs, temperature);
      const idx_next = topKIndices[sampleFromDistribution(probs)];

      history = history.concat(idx_next);

      console.log(`Output:\n${this.tokenizer.decode(history)}`);

      yield this.tokenizer.decode([idx_next]);
    }

    console.log(`Average kernel execution time: ${totalTime / max_new_tokens} ms`);
  }

  async run(idx) {
    const { posEmbdBuffer, layer_buffers, normGammaBuffer, normBetaBuffer, embeddingsBuffer } = this.model;
    const { attention_scale, n_embd, n_head, n_layer, vocab_size, hidden_size, vocab_chunk_size } = this.params;
    const seq_length = idx.length;

    // ---------------- Create Passes ---------------- //
    // Note: These are re-initialized because everytime seq_length changes buffers are different sizes.

    this.computePasses = [];
    let intermediateBuffer;
    let residualBuffer;
    {
      const { passes, resultBuffer } = EmbedBlock.newInstance(idx, seq_length, n_embd, embeddingsBuffer, posEmbdBuffer, ResidualBlock);
      intermediateBuffer = resultBuffer;
      residualBuffer = resultBuffer;
      this.computePasses.push(...passes);
    }
    for (let i = 0; i < n_layer; i++) {
      const buffers = layer_buffers[i];
      {
        const { passes, resultBuffer } = LayerNormBlock.newInstance(
          seq_length,
          n_embd,
          intermediateBuffer,
          buffers.normAttentionGammaBuffer,
          buffers.normAttentionBetaBuffer
        );
        intermediateBuffer = resultBuffer;
        this.computePasses.push(...passes);
      }
      {
        const { passes, resultBuffer } = AttentionBlock.newInstance(
          seq_length,
          n_embd,
          attention_scale,
          n_head,
          intermediateBuffer,
          buffers.qkvWeightsBuffer,
          buffers.qkvBiasBuffer,
          buffers.linearWeightsBuffer,
          buffers.linearBiasBuffer,
          FastMatMulBlock,
          FastRowAddBlock,
          SoftmaxBlock
        );
        intermediateBuffer = resultBuffer;
        this.computePasses.push(...passes);
      }
      {
        const { passes, resultBuffer } = ResidualBlock.newInstance(seq_length, n_embd, intermediateBuffer, residualBuffer);
        intermediateBuffer = resultBuffer;
        residualBuffer = resultBuffer;
        this.computePasses.push(...passes);
      }
      {
        const { passes, resultBuffer } = LayerNormBlock.newInstance(
          seq_length,
          n_embd,
          intermediateBuffer,
          buffers.normLinearGammaBuffer,
          buffers.normLinearBetaBuffer
        );
        intermediateBuffer = resultBuffer;
        this.computePasses.push(...passes);
      }
      {
        const { passes, resultBuffer } = FastFFNBlock.newInstance(
          seq_length,
          n_embd,
          hidden_size,
          intermediateBuffer,
          buffers.firstLayerWeightsBuffer,
          buffers.firstLayerBiasBuffer,
          buffers.secondLayerWeightsBuffer,
          buffers.secondLayerBiasBuffer,
          FastMatMulBlock,
          FastRowAddBlock,
          GeluBlock
        );
        intermediateBuffer = resultBuffer;
        this.computePasses.push(...passes);
      }
      {
        const { passes, resultBuffer } = ResidualBlock.newInstance(seq_length, n_embd, intermediateBuffer, residualBuffer);
        intermediateBuffer = resultBuffer;
        residualBuffer = resultBuffer;
        this.computePasses.push(...passes);
      }
    }
    {
      const { passes, resultBuffer } = LayerNormBlock.newInstance(seq_length, n_embd, intermediateBuffer, normGammaBuffer, normBetaBuffer);
      intermediateBuffer = resultBuffer;
      this.computePasses.push(...passes);
    }
    {
      const { passes, resultBuffer } = OldDeEmbedBlock.newInstance(vocab_size, n_embd, seq_length, intermediateBuffer, embeddingsBuffer, NaiveMatMulBlock);
      intermediateBuffer = resultBuffer;
      this.computePasses.push(...passes);
    }
    const resultBuffer = intermediateBuffer;

    // ---------------- Compute Passes ----------------

    const commandEncoder = this.device.createCommandEncoder();
    for (const pass of this.computePasses) {
      if (pass.flag === "compute") {
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(pass.pipeline);
        for (let i = 0; i < pass.groups.length; i++) passEncoder.setBindGroup(i, pass.groups[i]);
        passEncoder.dispatchWorkgroups(pass.workgroups.x, pass.workgroups.y);
        passEncoder.end();
      } else if (pass.flag === "copy") {
        commandEncoder.copyBufferToBuffer(pass.src, pass.srcOffset, pass.dst, pass.dstOffset, pass.size);
      }
    }
    this.device.queue.submit([commandEncoder.finish()]);

    // ---------------- Read Results ----------------

    await resultBuffer.mapAsync(GPUMapMode.READ);
    const output = resultBuffer.getMappedRange();
    const outputArray = new Float32Array(output).slice(0); // Copy the array, otherwise it'll be destroyed.

    destroyOperationBuffers();

    return outputArray;
  }

  async loadModel(folder) {
    if (this.initialized) return console.error("Model already loaded");

    console.log("Loading model from folder:", folder);
    const fldr = `models/${folder}/`;
    const zeros = (dim) => new Float32Array(dim).fill(0);

    console.log("Loading params...");
    const params = await (await fetch(`${fldr}/params_gpt.json`)).json();
    params.hidden_size = params.n_embd * 4;
    params.attention_scale = 1 / Math.sqrt(params.n_embd / params.n_head);
    var numBuffers = Math.ceil(this.bufferSize(params.vocab_size, params.n_embd) / this.device.limits.maxStorageBufferBindingSize); // Assumes that vocab_size has a decent least prime factor.
    params.num_instances = numBuffers > 1 ? leastPrimeFactor(params.vocab_size, numBuffers) : 1;
    params.vocab_chunk_size = params.vocab_size / numBuffers;
    const { block_size, n_embd, n_head, n_layer, bias, vocab_size, hidden_size, vocab_chunk_size, num_instances } = params;
    console.log("Params:", params);

    // Did you enable GitHub LFS? Won't work without it.
    if (n_embd % n_head != 0) throw new Error("Model load failed: n_embd must be divisible by n_head.");

    console.log("Loading token embeddings...");
    const embeddingWeights = await fetchBin(`${fldr}/transformer.wte.weight_gpt.bin`);
    const embeddingsBuffer = this.initTensor(embeddingWeights, [vocab_size, n_embd], ["copy_from"]);

    console.log("Loading positional embeddings...");
    const posEmbeddings = await fetchBin(`${fldr}/transformer.wpe.weight_gpt.bin`);
    const posEmbdBuffer = this.initTensor(posEmbeddings, [block_size, n_embd], ["copy_from"]);

    const layer_buffers = [];
    for (let i = 0; i < n_layer; i++) {
      console.log("Loading layer...", i);
      const prefix = `${fldr}transformer.h.${i}.`;

      const normAttentionGamma = await fetchBin(`${prefix}ln_1.weight_gpt.bin`);
      const normAttentionBeta = bias ? await fetchBin(`${prefix}ln_1.bias_gpt.bin`) : zeros(n_embd);

      const qkvWeights = transpose(await fetchBin(`${prefix}attn.c_attn.weight_gpt.bin`), 3 * n_embd, n_embd);
      const qkvBias = bias ? await fetchBin(`${prefix}attn.c_attn.bias_gpt.bin`) : zeros(3 * n_embd);

      const linearWeights = transpose(await fetchBin(`${prefix}attn.c_proj.weight_gpt.bin`), n_embd, n_embd);
      const linearBias = bias ? await fetchBin(`${prefix}attn.c_proj.bias_gpt.bin`) : zeros(n_embd);

      const attentionCache = zeros(block_size * n_head * block_size);

      const normLinearGamma = await fetchBin(`${prefix}ln_2.weight_gpt.bin`);
      const normLinearBeta = bias ? await fetchBin(`${prefix}ln_2.bias_gpt.bin`) : zeros(n_embd);

      const firstLayerWeights = transpose(await fetchBin(`${prefix}mlp.c_fc.weight_gpt.bin`), hidden_size, n_embd);
      const firstLayerBias = bias ? await fetchBin(`${prefix}mlp.c_fc.bias_gpt.bin`) : zeros(hidden_size);

      const secondLayerWeights = transpose(await fetchBin(`${prefix}mlp.c_proj.weight_gpt.bin`), n_embd, hidden_size);
      const secondLayerBias = bias ? await fetchBin(`${prefix}mlp.c_proj.bias_gpt.bin`) : zeros(n_embd);

      layer_buffers.push({
        normAttentionGammaBuffer: this.initTensor(normAttentionGamma, [n_embd], ["storage"]),
        normAttentionBetaBuffer: this.initTensor(normAttentionBeta, [n_embd], ["storage"]),
        qkvWeightsBuffer: this.initTensor(qkvWeights, [n_embd, 3 * n_embd], ["storage"]),
        qkvBiasBuffer: this.initTensor(qkvBias, [3 * n_embd], ["storage"]),
        linearWeightsBuffer: this.initTensor(linearWeights, [n_embd, n_embd], ["storage"]),
        linearBiasBuffer: this.initTensor(linearBias, [n_embd], ["storage"]),
        normLinearGammaBuffer: this.initTensor(normLinearGamma, [n_embd], ["storage"]),
        normLinearBetaBuffer: this.initTensor(normLinearBeta, [n_embd], ["storage"]),
        firstLayerWeightsBuffer: this.initTensor(firstLayerWeights, [n_embd, hidden_size], ["storage"]),
        firstLayerBiasBuffer: this.initTensor(firstLayerBias, [hidden_size], ["storage"]),
        secondLayerWeightsBuffer: this.initTensor(secondLayerWeights, [hidden_size, n_embd], ["storage"]),
        secondLayerBiasBuffer: this.initTensor(secondLayerBias, [n_embd], ["storage"]),
        attentionCacheBuffer: this.initTensor(attentionCache, [block_size * n_head, block_size], ["storage", "copy_from", "copy_to"]),
      });
    }

    console.log("Loading final layer norm...");
    const layerNormGamma = await fetchBin(`${fldr}/transformer.ln_f.weight_gpt.bin`);
    const layerNormBeta = bias ? await fetchBin(`${fldr}/transformer.ln_f.bias_gpt.bin`) : zeros(n_embd);
    const normGammaBuffer = this.initTensor(layerNormGamma, [n_embd], ["storage"]);
    const normBetaBuffer = this.initTensor(layerNormBeta, [n_embd], ["storage"]);

    const output = { layer_buffers, embeddingsBuffer, posEmbdBuffer, normGammaBuffer, normBetaBuffer };
    console.log("Finished loading model.", output, params);
    return [output, params];
  }

  initTensor(data, dims, ops) {
    const buffer = this.device.createBuffer({
      size: this.bufferSize(dims[0], dims[1] || 1, dims[2] || 1),
      usage: ops.map((u) => bufferUsageDict[u]).reduce((a, b) => a | b),
      mappedAtCreation: true,
    });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    this.unloadDeletionStack.push(buffer);
    return buffer;
  }

  unloadBuffers() {
    this.unloadDeletionStack.map((buffer) => buffer.destroy());
    this.unloadDeletionStack = [];
  }

  bufferSize(dimX, dimY = 1, dimZ = 1) {
    return Math.ceil((dimX * dimY * dimZ * Float32Array.BYTES_PER_ELEMENT) / this.minBufferOffset) * this.minBufferOffset;
  }
}