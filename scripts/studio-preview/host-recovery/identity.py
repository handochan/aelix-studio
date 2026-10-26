"""Bounded host code identity across installer signing on supported targets."""
import hashlib
import struct
import sys


def macho_code_identity(raw, details=None):
    """Hash every code byte, normalizing only bounded Mach-O signing metadata."""
    data = bytearray(raw)
    if len(data) < 32 or struct.unpack_from('<I', data)[0] != 0xFEEDFACF:
        raise ValueError('Expected a thin 64-bit Mach-O host')
    commands, command_bytes = struct.unpack_from('<II', data, 16)
    end, offset, linkedit, signature = 32 + command_bytes, 32, None, None
    if end > len(data):
        raise ValueError('Truncated Mach-O commands')
    for index in range(commands):
        if offset + 8 > end:
            raise ValueError('Truncated Mach-O command')
        command, size = struct.unpack_from('<II', data, offset)
        if size < 8 or offset + size > end:
            raise ValueError('Invalid Mach-O command')
        if command == 0x19 and data[offset + 8:offset + 24].rstrip(b'\0') == b'__LINKEDIT':
            if linkedit is not None or size < 72:
                raise ValueError('Invalid LINKEDIT command')
            vm_size, file_offset, file_size = struct.unpack_from('<QQQ', data, offset + 32)
            if vm_size < file_size or file_offset < end or file_offset + file_size != len(data):
                raise ValueError('Invalid LINKEDIT extent')
            linkedit = (offset, vm_size, file_offset, file_size)
        if command == 0x1D:
            if signature is not None or size != 16 or index != commands - 1:
                raise ValueError('Signature command must be the final 16-byte command')
            at, length = struct.unpack_from('<II', data, offset + 8)
            if at % 16 or at + length != len(data) or length < 12:
                raise ValueError('Invalid terminal signature extent')
            magic, declared, count = struct.unpack_from('>III', data, at)
            if magic != 0xFADE0CC0 or not (12 <= declared <= length) or not (1 <= count <= (declared - 12) // 8):
                raise ValueError('Invalid embedded signature SuperBlob')
            for entry in range(count):
                blob = struct.unpack_from('>I', data, at + 16 + entry * 8)[0]
                if blob < 12 + count * 8 or blob + 8 > declared:
                    raise ValueError('Invalid signature index')
                blob_length = struct.unpack_from('>I', data, at + blob + 4)[0]
                if blob_length < 8 or blob + blob_length > declared:
                    raise ValueError('Invalid signature blob extent')
            signature = (offset, at, length, declared, count)
        offset += size
    if linkedit is None or offset != end:
        raise ValueError('Missing or malformed LINKEDIT')
    segment, vm_size, file_offset, file_size = linkedit
    if signature and signature[1] < file_offset:
        raise ValueError('Signature is outside LINKEDIT')
    if details is not None:
        details.update(bytes=len(raw), cpuType=struct.unpack_from('<I', raw, 4)[0],
                       commands=commands, commandBytes=command_bytes,
                       linkedit=dict(commandOffset=segment, vmSize=vm_size, fileOffset=file_offset, fileSize=file_size),
                       signature=(dict(commandOffset=signature[0], dataOffset=signature[1], dataSize=signature[2],
                                       superBlobLength=signature[3], blobs=signature[4]) if signature else None))
    if signature:
        command_offset, body_end, _, _, _ = signature
        data = data[:body_end]
        # The last command occupies existing header padding. Clear that slot;
        # no mapped body offsets or ordinary load commands are shifted.
        data[command_offset:command_offset + 16] = b'\0' * 16
        struct.pack_into('<II', data, 16, commands - 1, command_bytes - 16)
    # Signing aligns its terminal payload to16 bytes. Add only zeros, retaining
    # every existing body byte; a nonzero alignment change still changes the hash.
    data.extend(b'\0' * ((-len(data)) % 16))
    struct.pack_into('<Q', data, segment + 32, 0)
    struct.pack_into('<Q', data, segment + 48, len(data) - file_offset)
    return hashlib.sha256(data).hexdigest()


def host_identity(path, details=None):
    raw = path.read_bytes()
    if sys.platform == 'darwin':
        return macho_code_identity(raw, details)
    if details is not None:
        details.update(bytes=len(raw))
    return hashlib.sha256(raw).hexdigest()

