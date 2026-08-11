import { defineConfig } from 'vitest/config';

// Testler saf TS mantığını (lib/) hedefler — DOM/React ortamı gerekmez, bu yüzden
// 'node' ortamı yeterli ve hızlıdır. React bileşen testleri eklenirse
// environment: 'jsdom' + @testing-library/react gerekecek.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
