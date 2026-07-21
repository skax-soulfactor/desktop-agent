// build/icon.svg → 배포용 PNG 아이콘 생성
// 사용: node scripts/make-icons.mjs
import sharp from 'sharp'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = join(root, 'build', 'icon.svg')

mkdirSync(join(root, 'resources'), { recursive: true })

// electron-builder가 이 1024px PNG에서 icns/ico를 자동 생성한다
await sharp(svg, { density: 300 }).resize(1024, 1024).png().toFile(join(root, 'build', 'icon.png'))
// 리눅스 창 아이콘 등 런타임에서 쓰는 사본
await sharp(svg, { density: 300 }).resize(512, 512).png().toFile(join(root, 'resources', 'icon.png'))

console.log('generated build/icon.png (1024) and resources/icon.png (512)')
