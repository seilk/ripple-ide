// One block per row. Each thread adds a strided share of the row into a
// small stack array, then thread 0 adds the per-thread sums from shared memory.
//
// Two things to find in the report:
//   1. `lane` is a stack array, so it becomes thread-local memory (ld/st.local).
//   2. `lanes` is a run-time value, so `c % lanes` is a real `rem` in the hot loop.
#define MAX_LANES 8

__global__ void rowsum(const float* in, float* out, int cols, int lanes) {
  __shared__ float partial[256];
  float lane[MAX_LANES];
  for (int k = 0; k < MAX_LANES; ++k) lane[k] = 0.0f;

  const float* row = in + (size_t)blockIdx.x * cols;
  for (int c = threadIdx.x; c < cols; c += blockDim.x) {
    lane[c % lanes] += row[c];
  }

  float sum = 0.0f;
  for (int k = 0; k < MAX_LANES; ++k) sum += lane[k];
  partial[threadIdx.x] = sum;
  __syncthreads();

  if (threadIdx.x == 0) {
    float total = 0.0f;
    for (unsigned j = 0; j < blockDim.x; ++j) total += partial[j];
    out[blockIdx.x] = total / cols;
  }
}
