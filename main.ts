// tiny-stack-vm: an interpreter for make.fun's tiny stack ISA (v1).
// Runs each /input/<id>/program.bin against its input.bin and writes
// /output/<id>/stdout.bin and /output/<id>/exit.txt, per the kit's ISA
// sheet: wrapping 32-bit values, a 256-deep stack, 256 words of memory,
// ten traps, 1,000,000 steps, 65,536 output bytes at most.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

// Run one program; return its output bytes and exit code.
function runProgram(prog, input) {
  const st = new Int32Array(256);
  let sp = 0; // values held on the data stack
  const calls = []; // return addresses pushed by CALL
  const mem = new Int32Array(256); // memory, zero-filled
  const out = []; // bytes written so far
  let pc = 0, inAt = 0, steps = 0;

  // Stack gate for every opcode, checked before its own traps:
  // popping more than held traps 2, ending deeper than 256 traps 3.
  function require(pops, pushes) {
    if (sp < pops) throw 2;
    if (sp - pops + pushes > 256) throw 3;
  }
  // Signed 16-bit offset of the jump at pc (its bytes known to fit).
  function offset() {
    return ((prog[pc + 1] | (prog[pc + 2] << 8)) << 16) >> 16;
  }
  function operands() {
    require(2, 1);
    sp -= 1;
    return [st[sp - 1], st[sp]];
  }

  // Halts, exits and traps are thrown as their numeric exit code.
  try {
    for (;;) {
      if (steps >= 1000000) throw 10;
      if (pc < 0 || pc >= prog.length) throw 9;
      const op = prog[pc];
      steps += 1;
      switch (op) {
      case 0x00: // HALT
        throw 0;
      case 0x01: // PUSH8: the byte sign-extended
        if (pc + 2 > prog.length) throw 9;
        require(0, 1);
        st[sp++] = (prog[pc + 1] << 24) >> 24;
        pc += 2;
        break;
      case 0x02: // PUSH32: little-endian word
        if (pc + 5 > prog.length) throw 9;
        require(0, 1);
        st[sp++] = prog[pc + 1] | (prog[pc + 2] << 8) |
          (prog[pc + 3] << 16) | (prog[pc + 4] << 24);
        pc += 5;
        break;
      case 0x03: // POP
        require(1, 0); sp -= 1; pc += 1; break;
      case 0x04: // DUP
        require(1, 2); st[sp] = st[sp - 1]; sp += 1; pc += 1; break;
      case 0x05: { // SWAP
        require(2, 2);
        const top = st[sp - 1];
        st[sp - 1] = st[sp - 2]; st[sp - 2] = top;
        pc += 1; break;
      }
      case 0x06: // OVER
        require(2, 3); st[sp] = st[sp - 2]; sp += 1; pc += 1; break;
      case 0x07: { // ROT: ( a b c -- b c a )
        require(3, 3);
        const a = st[sp - 3];
        st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a;
        pc += 1; break;
      }
      // Sixteen binary operators, one stack shape; the inner switch
      // is only the arithmetic (division via the remainder, exact).
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
      case 0x16: case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d:
      case 0x1e: case 0x20: case 0x21: case 0x22: {
        const [a, b] = operands();
        let r;
        switch (op) {
        case 0x10: r = a + b; break; // ADD
        case 0x11: r = a - b; break; // SUB
        case 0x12: r = Math.imul(a, b); break; // MUL
        case 0x13: if (b === 0) throw 4; r = (a - (a % b)) / b; break; // DIV
        case 0x14: if (b === 0) throw 4; r = a % b; break; // MOD
        case 0x15: if (b === 0) throw 4; r = ((a >>> 0) - ((a >>> 0) % (b >>> 0))) / (b >>> 0); break; // DIVU
        case 0x16: if (b === 0) throw 4; r = (a >>> 0) % (b >>> 0); break; // MODU
        case 0x18: r = a & b; break; // AND
        case 0x19: r = a | b; break; // OR
        case 0x1a: r = a ^ b; break; // XOR
        case 0x1c: r = a << (b & 31); break; // SHL
        case 0x1d: r = a >> (b & 31); break; // SHR
        case 0x1e: r = a >>> (b & 31); break; // SHRU
        case 0x20: r = a === b ? 1 : 0; break; // EQ
        case 0x21: r = a < b ? 1 : 0; break; // LT
        case 0x22: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // LTU
        }
        st[sp - 1] = r;
        pc += 1;
        break;
      }
      case 0x17: // NEG (the store wraps -MIN back to MIN)
        require(1, 1); st[sp - 1] = -st[sp - 1]; pc += 1; break;
      case 0x1b: // NOT
        require(1, 1); st[sp - 1] = ~st[sp - 1]; pc += 1; break;
      case 0x30: // JMP: offset from the next instruction
        if (pc + 3 > prog.length) throw 9;
        pc = pc + 3 + offset();
        break;
      case 0x31: case 0x32: { // JZ / JNZ: one test covers both
        if (pc + 3 > prog.length) throw 9;
        require(1, 0);
        const v = st[--sp];
        pc = (op === 0x31) === (v === 0) ? pc + 3 + offset() : pc + 3;
        break;
      }
      case 0x33: // CALL: the immediate is an absolute address
        if (pc + 3 > prog.length) throw 9;
        if (calls.length >= 64) throw 7;
        calls.push(pc + 3);
        pc = prog[pc + 1] | (prog[pc + 2] << 8);
        break;
      case 0x34: // RET
        if (calls.length === 0) throw 8;
        pc = calls.pop();
        break;
      case 0x40: { // LOAD
        require(1, 1);
        const addr = st[sp - 1];
        if (addr < 0 || addr > 255) throw 6;
        st[sp - 1] = mem[addr];
        pc += 1; break;
      }
      case 0x41: { // STORE: ( v addr -- )
        require(2, 0);
        const addr = st[sp - 1];
        if (addr < 0 || addr > 255) throw 6;
        mem[addr] = st[sp - 2];
        sp -= 2; pc += 1; break;
      }
      case 0x50: { // PRINT: decimal; crossing the limit writes nothing
        require(1, 0);
        const text = String(st[--sp]);
        if (out.length + text.length > 65536) throw 11;
        for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i));
        pc += 1; break;
      }
      case 0x51: // PUTC: one byte, the value's low eight bits
        require(1, 0);
        if (out.length + 1 > 65536) throw 11;
        out.push(st[--sp] & 255);
        pc += 1; break;
      case 0x52: // IN: -1 once the input is used up
        require(0, 1);
        st[sp++] = inAt < input.length ? input[inAt++] : -1;
        pc += 1; break;
      case 0x53: // EXIT: only the operand's low byte is the code
        require(1, 0);
        throw st[--sp] & 255;
      default: // a byte no opcode names
        throw 5;
      }
    }
  } catch (code) {
    if (typeof code !== "number") throw code;
    return { out, code };
  }
}

function main() {
  const ids = readdirSync("/input", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const id of ids) {
    const prog = readFileSync("/input/" + id + "/program.bin");
    let input;
    try {
      input = readFileSync("/input/" + id + "/input.bin");
    } catch {
      input = Buffer.alloc(0);
    }
    const result = runProgram(prog, input);
    mkdirSync("/output/" + id, { recursive: true });
    writeFileSync("/output/" + id + "/stdout.bin", Buffer.from(result.out));
    writeFileSync("/output/" + id + "/exit.txt", result.code + "\n");
  }
}

main();
