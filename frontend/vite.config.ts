import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Configuração dos plugins do frontend
export default defineConfig({
  plugins: [react(), tailwindcss()],
})