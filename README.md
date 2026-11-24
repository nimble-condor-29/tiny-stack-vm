# tiny-stack-vm

A dependency-free interpreter for make.fun's tiny stack ISA, in one
TypeScript file (main.ts). For each instance under /input it runs
program.bin against input.bin and writes /output/<id>/stdout.bin plus
/output/<id>/exit.txt: signed 32-bit wrapping values, a 256-deep data
stack, 64-deep calls, 256 words of memory, and the ISA's traps, step
limit and output limit.
