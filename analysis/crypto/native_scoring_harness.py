"""Bounded offline execution of build 25 ARM64 methods (no Android/Unity loop).

Callers must list every host substitution. Client instructions are mapped intact;
unknown reads outside the ELF and explicit fixture arena fail closed.
Requires the versions in crypto/requirements.txt and analysis/vendor dependencies.
"""
from __future__ import annotations
import hashlib
import bisect
import struct
import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'vendor')]
from crypto.inspect_il2cpp import ElfMemory
from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_INVALID
from unicorn.arm64_const import UC_ARM64_REG_X0, UC_ARM64_REG_X30, UC_ARM64_REG_SP, UC_ARM64_REG_PC

ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / 'input/global/apks/2026-09-22-v1.0.1-25/libil2cpp.so'
DECODED = ROOT / 'input/global/decrypted/2026-09-22-v1.0.1-25/il2cpp/libil2cpp.decoded.so'
CLIENT_SHA = '514a5b73d038c264b60cc91fd4a747cf178190c6b2096e6d7007c2020e2b1bca'
DECODED_SHA = '393a166e12f1886597709aa82e93bc58283631d629238e10e22fa10efc3f24eb'

class NativeHarness:
    def __init__(self, *, client=CLIENT, decoded=DECODED, client_sha=CLIENT_SHA, decoded_sha=DECODED_SHA):
        if hashlib.sha256(client.read_bytes()).hexdigest() != client_sha:
            raise ValueError('client identity differs from the audited build')
        if hashlib.sha256(decoded.read_bytes()).hexdigest() != decoded_sha:
            raise ValueError('decoded client identity differs from the audited build')
        self.memory = ElfMemory(decoded)
        self.relocation_addresses = sorted(self.memory.relative_relocations)
        self.uc = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
        self.mapped = set()
        self.callbacks = {}
        self.observers = {}
        self.trace = []
        self.arena = 0x20000000
        self.cursor = self.arena
        self.uc.mem_map(self.arena, 0x200000)
        self.uc.mem_map(0x30000000, 0x20000)
        self.stop = self.arena + 0x1ff000
        self.uc.hook_add(UC_HOOK_MEM_INVALID, self._missing)
        self.uc.hook_add(UC_HOOK_CODE, self._code)

    def page(self, address):
        page = address & ~4095
        if page in self.mapped or self.arena <= page < self.arena + 0x200000:
            return
        segments = [s for s in self.memory.segments if s.p_vaddr < page + 4096 and page < s.p_vaddr + s.p_memsz]
        if not segments:
            raise ValueError(f'unmapped fixture access {address:#x}')
        self.uc.mem_map(page, 4096)
        self.mapped.add(page)
        for s in segments:
            start, end = max(page, s.p_vaddr), min(page + 4096, s.p_vaddr + s.p_filesz)
            if end > start:
                self.uc.mem_write(start, self.memory.read(start, end - start))
        lo = bisect.bisect_left(self.relocation_addresses, page)
        hi = bisect.bisect_left(self.relocation_addresses, page + 4096)
        for addr in self.relocation_addresses[lo:hi]:
            self.uc.mem_write(addr, struct.pack('<Q', self.memory.relative_relocations[addr]))

    def _missing(self, uc, access, address, size, value, _):
        self.page(address)
        if (address + size - 1) // 4096 != address // 4096:
            self.page(address + size - 1)
        return True

    def _code(self, uc, address, size, _):
        if address in self.observers:
            self.observers[address](self)
        if address in self.callbacks:
            self.callbacks[address](self)

    def alloc(self, size=0x100):
        value = self.cursor
        self.cursor += (size + 15) & ~15
        if self.cursor >= self.stop:
            raise ValueError('fixture arena exhausted')
        return value

    def write(self, address, data):
        for page in range(address & ~4095, (address + len(data) + 4095) & ~4095, 4096):
            self.page(page)
        self.uc.mem_write(address, data)

    def u64(self, address, value=None):
        if value is None:
            return struct.unpack('<Q', self.uc.mem_read(address, 8))[0]
        self.write(address, struct.pack('<Q', value & ((1 << 64) - 1)))

    def i32(self, address, value=None):
        if value is None:
            return struct.unpack('<i', self.uc.mem_read(address, 4))[0]
        self.write(address, struct.pack('<I', value & 0xffffffff))

    def f32(self, address, value=None):
        if value is None:
            return struct.unpack('<f', self.uc.mem_read(address, 4))[0]
        self.write(address, struct.pack('<f', value))

    def reg(self, index, value=None):
        if value is None:
            return self.uc.reg_read(UC_ARM64_REG_X0 + index)
        self.uc.reg_write(UC_ARM64_REG_X0 + index, value & ((1 << 64) - 1))

    def ret(self, value=None):
        if value is not None:
            self.reg(0, value)
        self.uc.reg_write(UC_ARM64_REG_PC, self.uc.reg_read(UC_ARM64_REG_X30))

    def stub(self, callback):
        address = self.alloc(16)
        self.uc.mem_write(address, bytes.fromhex('c0035fd6'))
        self.callbacks[address] = callback
        return address

    def call(self, address, *args, limit=200000):
        self.uc.reg_write(UC_ARM64_REG_SP, 0x3001f000)
        self.uc.reg_write(UC_ARM64_REG_X30, self.stop)
        for i, arg in enumerate(args):
            self.reg(i, arg)
        self.uc.emu_start(address, self.stop, count=limit)
        if self.uc.reg_read(UC_ARM64_REG_PC) != self.stop:
            raise RuntimeError(f'instruction limit reached at {self.uc.reg_read(UC_ARM64_REG_PC):#x}')
        return self.reg(0)

    def close(self):
        self.memory.close()
