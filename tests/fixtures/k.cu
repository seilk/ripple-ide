__global__ void saxpy(float a, const float* x, float* y, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) y[i] = a * x[i] + y[i] * 0.5;
}
__global__ void rowsum(const float* in, float* out, int cols) {
  __shared__ float acc[256];
  float local[8];
  for (int k = 0; k < 8; ++k) local[k] = 0;
  for (int c = threadIdx.x; c < cols; c += blockDim.x) local[c % 8] += in[blockIdx.x * cols + c];
  float s = 0; for (int k = 0; k < 8; ++k) s += local[k];
  acc[threadIdx.x] = s;
  __syncthreads();
  if (threadIdx.x == 0) { float t = 0; for (int j = 0; j < blockDim.x; ++j) t += acc[j]; out[blockIdx.x] = t / cols; }
}
