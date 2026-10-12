import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],build:{outDir:'../../dist/web',emptyOutDir:true},server:{proxy:{'/api':{target:'http://127.0.0.1:3002',rewrite:path=>path.replace(/^\/api/,'')}}}});
