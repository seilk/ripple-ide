"""Row softmax in Triton.

Run needs a CUDA device with torch and triton on the runner. The IDE runs this
file, then reads the PTX that Triton wrote to its cache.
"""

import torch
import triton
import triton.language as tl


@triton.jit
def softmax_kernel(x_ptr, y_ptr, stride, n_cols, BLOCK: tl.constexpr):
    row = tl.program_id(0)
    offsets = tl.arange(0, BLOCK)
    mask = offsets < n_cols
    x = tl.load(x_ptr + row * stride + offsets, mask=mask, other=-float("inf"))
    x = x - tl.max(x, axis=0)
    num = tl.exp(x)
    den = tl.sum(num, axis=0)
    tl.store(y_ptr + row * stride + offsets, num / den, mask=mask)


def softmax(x: torch.Tensor) -> torch.Tensor:
    rows, cols = x.shape
    y = torch.empty_like(x)
    block = triton.next_power_of_2(cols)
    softmax_kernel[(rows,)](x, y, x.stride(0), cols, BLOCK=block)
    return y


if __name__ == "__main__":
    data = torch.randn(64, 1000, device="cuda")
    out = softmax(data)
    ref = torch.softmax(data, dim=1)
    print("max abs error:", (out - ref).abs().max().item())
