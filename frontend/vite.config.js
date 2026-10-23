import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'version-plugin',
      writeBundle() {
        // 从Android build.gradle读取版本信息
        const androidBuildGradle = path.join(__dirname, 'android/app/build.gradle');
        let versionName = '1.0';
        let versionCode = 1;
        
        try {
          const content = fs.readFileSync(androidBuildGradle, 'utf-8');
          const versionNameMatch = content.match(/versionName\s+"([^"]+)"/);
          const versionCodeMatch = content.match(/versionCode\s+(\d+)/);
          if (versionNameMatch) versionName = versionNameMatch[1];
          if (versionCodeMatch) versionCode = parseInt(versionCodeMatch[1]);
        } catch (err) {
          console.log('Could not read Android version, using defaults');
        }
        
        // 生成version.json
        const versionJson = JSON.stringify({ versionName, versionCode }, null, 2);
        const outputPath = path.join(__dirname, 'dist/version.json');
        fs.writeFileSync(outputPath, versionJson);
        console.log(`Version config generated: ${versionJson}`);
      }
    }
  ],
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    allowedHosts: ['.cpolar.top','.cpolar.cn','.trycloudflare.com','.ngrok-free.app'], // Allow access via cpolar domains
    hmr: {
      clientPort: 443, // cpolar uses 443 for HTTPS, this fixes HMR on public domains
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://127.0.0.1:3001',
        ws: true, // Support WebSockets for Socket.io
        changeOrigin: true,
      },
    },
  },
})
