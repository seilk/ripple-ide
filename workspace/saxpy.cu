// y = a * x + 0.5 * y
// The literal 0.5 has no f suffix, so the multiply runs in double precision.
// Compile, then look at the fp64 findings in the report.
__global__ void saxpy(float a, const float* x, float* y, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) {
    y[i] = a * x[i] + 0.5 * y[i];
  }
}
