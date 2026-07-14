// Fetches today's Multicampus lunch menu via Welstory and posts it to Mattermost
// via an Incoming Webhook. Runs daily via GitHub Actions.
//
// Incoming Webhooks can't upload files, so images are linked directly from
// Welstory's CDN instead of being re-hosted on Mattermost.

import 'dotenv/config'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Menu, Restaurant } from '@pmh-only/welplan2-model'
import { WelstoryPlusClient } from '@pmh-only/welplan2-welstory-plus'

// Overwritten daily and committed by CI: keeps the repo small while still
// producing a daily diff, which keeps GitHub from disabling the schedule trigger.
const IMAGES_DIR = path.join(process.cwd(), 'images')

const RESTAURANT_ID = process.env.RESTAURANT_ID
const RESTAURANT_NAME = process.env.RESTAURANT_NAME ?? '멀티캠퍼스'
const MEAL_TIME_ID = process.env.MEAL_TIME_ID

const MATTERMOST_WEBHOOK_URL = process.env.MATTERMOST_WEBHOOK_URL
const MATTERMOST_USERNAME = process.env.MATTERMOST_USERNAME ?? '점심봇'
const MATTERMOST_ICON_URL = process.env.MATTERMOST_ICON_URL

function todayYYYYMMDD(): string {
  const kstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }))
  const year = kstNow.getFullYear()
  const month = String(kstNow.getMonth() + 1).padStart(2, '0')
  const day = String(kstNow.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function isWeekend(): boolean {
  const kstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }))
  const dayOfWeek = kstNow.getDay()
  return dayOfWeek === 0 || dayOfWeek === 6
}

// getRestaurants() only returns restaurants already registered to the account.
async function ensureRegistered(client: WelstoryPlusClient, restaurant: Restaurant): Promise<void> {
  const myList = await client.getRestaurants()
  const isRegistered = myList.some((r) => r.id === restaurant.id)
  if (!isRegistered) {
    console.log(`${restaurant.name} (${restaurant.id}) not registered, registering...`)
    await client.addRestaurant(restaurant.id)
  }
}

// getMenus() may only return the main dish per course; fetch the full side-dish
// list via getMenuDetail. menu.nutrition totals from getMenus() are already correct.
async function enrichMenusWithDetails(
  client: WelstoryPlusClient,
  restaurant: Restaurant,
  date: string,
  mealTimeId: string,
  menus: Menu[]
): Promise<Menu[]> {
  const enriched: Menu[] = []

  for (const menu of menus) {
    if (!menu.hallNo || !menu.courseType) {
      enriched.push(menu)
      continue
    }

    try {
      const details = await client.getMenuDetail(restaurant, date, mealTimeId, menu.hallNo, menu.courseType)
      enriched.push(details.length > 0 ? { ...menu, components: details } : menu)
    } catch (err) {
      console.error(`Failed to fetch side dish details for '${menu.name}', using basic components:`, err)
      enriched.push(menu)
    }
  }

  return enriched
}

interface RawMealListResponse {
  data?: {
    mealList?: Array<{ hallNo: string; menuCourseType: string; courseTxt?: string | null }>
  }
}

interface RequestCapable {
  request(path: string): Promise<unknown>
}

// courseTxt (e.g. "A:한식") isn't exposed by the public API, so call the
// library's private request() directly to read it from the raw response.
async function fetchCourseLabels(
  client: WelstoryPlusClient,
  restaurant: Restaurant,
  date: string,
  mealTimeId: string
): Promise<Map<string, string>> {
  const labels = new Map<string, string>()

  try {
    const raw = (await (client as unknown as RequestCapable).request(
      `/api/meal?menuDt=${date}&menuMealType=${mealTimeId}&restaurantCode=${restaurant.id}`
    )) as RawMealListResponse

    for (const dish of raw.data?.mealList ?? []) {
      const key = `${dish.hallNo}-${dish.menuCourseType}`
      if (!labels.has(key) && dish.courseTxt) {
        labels.set(key, dish.courseTxt.replace(/^[^:]*:/, '').trim())
      }
    }
  } catch (err) {
    console.error('Failed to fetch course labels (courseTxt), proceeding without labels:', err)
  }

  return labels
}

function menuKey(menu: Menu): string | undefined {
  return menu.hallNo && menu.courseType ? `${menu.hallNo}-${menu.courseType}` : undefined
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'menu'
}

function extensionFromContentType(contentType: string | null): string {
  switch (contentType) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/png':
    default:
      return '.png'
  }
}

async function downloadImage(imageUrl: string): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetch(imageUrl)
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status} ${imageUrl}`)
  }
  const contentType = response.headers.get('content-type') ?? 'image/png'
  const buffer = Buffer.from(await response.arrayBuffer())
  return { buffer, contentType }
}

// Saves a local copy of each course image purely so CI has something to commit
// daily (see the workflow's "keep schedule trigger alive" step). The message
// itself links directly to Welstory's CDN, so this has no effect on the post.
async function saveMenuImagesLocally(menus: Menu[], courseLabels: Map<string, string>): Promise<void> {
  // Clear stale files first so a course with no image today doesn't leave
  // yesterday's photo sitting under its filename.
  await rm(IMAGES_DIR, { recursive: true, force: true })
  await mkdir(IMAGES_DIR, { recursive: true })

  for (const menu of menus) {
    if (!menu.imageUrl) continue

    const key = menuKey(menu)
    const title = (key ? courseLabels.get(key) : undefined) ?? menu.name

    try {
      const { buffer, contentType } = await downloadImage(menu.imageUrl)
      const filename = `${sanitizeFilename(title)}${extensionFromContentType(contentType)}`
      await writeFile(path.join(IMAGES_DIR, filename), buffer)
    } catch (err) {
      console.error(`Failed to save local copy of image for '${title}':`, err)
    }
  }
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

// menu.name equals the main dish's name, so use it to detect and bold that row.
function componentCell(component: Menu['components'][number], menu: Menu): string {
  const kcal = component.nutrition?.calories
  const kcalText = kcal !== undefined ? ` (${kcal}kcal)` : ''
  const text = escapeTableCell(`${component.name}${kcalText}`)
  return component.name === menu.name ? `**${text}**` : text
}

function totalsCell(menu: Menu): string {
  const n = menu.nutrition
  if (!n) return ''

  const summary: string[] = []
  if (n.calories !== undefined) summary.push(`칼로리 ${n.calories}kcal`)
  if (n.protein !== undefined) summary.push(`단백질 ${n.protein}g`)
  if (n.fat !== undefined) summary.push(`지방 ${n.fat}g`)
  if (n.sodium !== undefined) summary.push(`나트륨 ${n.sodium}mg`)
  if (n.sugar !== undefined) summary.push(`당류 ${n.sugar}g`)

  return summary.length > 0 ? `영양 정보: ${summary.join(' / ')}` : ''
}

// Builds a markdown table: header row is the course label, then image, then
// one row per side dish, then a totals row. Shorter courses get blank cells.
// Images link directly to Welstory's CDN with Mattermost's `=WxH` size syntax.
function formatMenuMessage(menus: Menu[], dateLabel: string, courseLabels: Map<string, string>): string {
  if (menus.length === 0) {
    return `### 📅 ${dateLabel} ${RESTAURANT_NAME} 점심 식단\n\n오늘은 등록된 식단이 없습니다.`
  }

  const titles = menus.map((menu) => {
    const key = menuKey(menu)
    return escapeTableCell((key ? courseLabels.get(key) : undefined) ?? menu.name)
  })
  const imageCells = menus.map((menu, i) => (menu.imageUrl ? `![${titles[i]}](${menu.imageUrl} =200x200)` : ''))

  const headerRow = `| ${titles.join(' | ')} |`
  // Center-align columns so images sit in the middle of the cell.
  const separatorRow = `| ${titles.map(() => ':---:').join(' | ')} |`
  const imageRow = `| ${imageCells.join(' | ')} |`

  const maxComponents = Math.max(...menus.map((menu) => menu.components.length))
  const componentRows: string[] = []
  for (let i = 0; i < maxComponents; i++) {
    const cells = menus.map((menu) => (menu.components[i] ? componentCell(menu.components[i], menu) : ''))
    componentRows.push(`| ${cells.join(' | ')} |`)
  }

  const totalsRow = `| ${menus.map(totalsCell).join(' | ')} |`

  return [
    `### 📅 ${dateLabel} ${RESTAURANT_NAME} 점심 식단`,
    '',
    headerRow,
    separatorRow,
    imageRow,
    ...componentRows,
    totalsRow,
  ].join('\n')
}

async function postToMattermost(message: string): Promise<void> {
  const payload: Record<string, unknown> = { text: message, username: MATTERMOST_USERNAME }
  if (MATTERMOST_ICON_URL) payload.icon_url = MATTERMOST_ICON_URL

  const response = await fetch(MATTERMOST_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to send message to Mattermost: ${response.status} ${errorText}`)
  }
}

async function main(): Promise<void> {
  if (isWeekend()) {
    console.log('Skipping: no menu on weekends')
    return
  }

  if (!RESTAURANT_ID || !MEAL_TIME_ID) {
    throw new Error(
      'RESTAURANT_ID / MEAL_TIME_ID environment variables are required. Run find-restaurant.ts first to obtain them.'
    )
  }
  if (!MATTERMOST_WEBHOOK_URL) {
    throw new Error('MATTERMOST_WEBHOOK_URL environment variable is required.')
  }

  const client = new WelstoryPlusClient({
    username: process.env.WELSTORY_USERNAME,
    password: process.env.WELSTORY_PASSWORD,
  })

  const restaurant: Restaurant = {
    id: RESTAURANT_ID,
    name: RESTAURANT_NAME,
    vendor: 'welstory',
  }

  await ensureRegistered(client, restaurant)

  const date = todayYYYYMMDD()
  const menus = await client.getMenus(restaurant, date, MEAL_TIME_ID)
  const enrichedMenus = await enrichMenusWithDetails(client, restaurant, date, MEAL_TIME_ID, menus)
  const courseLabels = await fetchCourseLabels(client, restaurant, date, MEAL_TIME_ID)

  await saveMenuImagesLocally(enrichedMenus, courseLabels)

  const dateLabel = `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}`
  const message = formatMenuMessage(enrichedMenus, dateLabel, courseLabels)

  await postToMattermost(message)
  console.log('Message sent successfully')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
