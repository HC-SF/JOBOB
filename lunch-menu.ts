// Fetches today's Multicampus lunch menu via Welstory and posts it to Mattermost
// via an Incoming Webhook. Run directly (`npm run post-lunch`) to send today's
// menu using credentials from .env.
//
// Incoming Webhooks can't upload files, so images are linked directly from
// Welstory's CDN instead of being re-hosted on Mattermost.
//
// Welstory blocks logins from Google Cloud IPs, so this must run from a
// non-cloud egress IP (confirmed: identical credentials work from a
// local/residential IP but fail with "No Authorization header in login
// response" from Cloud Functions).

import 'dotenv/config'
import type { Menu, Restaurant } from '@pmh-only/welplan2-model'
import { WelstoryPlusClient } from '@pmh-only/welplan2-welstory-plus'

interface LunchMenuConfig {
  restaurantId: string
  restaurantName: string
  mealTimeId: string
  mattermostWebhookUrl: string
  mattermostUsername?: string
  mattermostIconUrl?: string
  welstoryUsername?: string
  welstoryPassword?: string
}

function todayYYYYMMDD(): string {
  const kstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }))
  const year = kstNow.getFullYear()
  const month = String(kstNow.getMonth() + 1).padStart(2, '0')
  const day = String(kstNow.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

export function isWeekend(): boolean {
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
function formatMenuMessage(
  menus: Menu[],
  dateLabel: string,
  courseLabels: Map<string, string>,
  restaurantName: string
): string {
  if (menus.length === 0) {
    return `### 📅 ${dateLabel} ${restaurantName} 점심 식단\n\n오늘은 등록된 식단이 없습니다.`
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
    `### 📅 ${dateLabel} ${restaurantName} 점심 식단`,
    '',
    headerRow,
    separatorRow,
    imageRow,
    ...componentRows,
    totalsRow,
  ].join('\n')
}

async function postToMattermost(
  message: string,
  webhookUrl: string,
  username: string,
  iconUrl: string | undefined
): Promise<void> {
  const payload: Record<string, unknown> = { text: message, username }
  if (iconUrl) payload.icon_url = iconUrl

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to send message to Mattermost: ${response.status} ${errorText}`)
  }
}

async function postLunchMenu(config: LunchMenuConfig): Promise<void> {
  if (isWeekend()) {
    console.log('Skipping: no menu on weekends')
    return
  }

  const client = new WelstoryPlusClient({
    username: config.welstoryUsername,
    password: config.welstoryPassword,
  })

  const restaurant: Restaurant = {
    id: config.restaurantId,
    name: config.restaurantName,
    vendor: 'welstory',
  }

  await ensureRegistered(client, restaurant)

  const date = todayYYYYMMDD()
  const menus = await client.getMenus(restaurant, date, config.mealTimeId)
  const enrichedMenus = await enrichMenusWithDetails(client, restaurant, date, config.mealTimeId, menus)
  const courseLabels = await fetchCourseLabels(client, restaurant, date, config.mealTimeId)

  const dateLabel = `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}`
  const message = formatMenuMessage(enrichedMenus, dateLabel, courseLabels, config.restaurantName)

  await postToMattermost(
    message,
    config.mattermostWebhookUrl,
    config.mattermostUsername ?? '점심봇',
    config.mattermostIconUrl
  )
  console.log('Message sent successfully')
}

const RESTAURANT_ID = process.env.RESTAURANT_ID
const RESTAURANT_NAME = process.env.RESTAURANT_NAME ?? '멀티캠퍼스'
const MEAL_TIME_ID = process.env.MEAL_TIME_ID
const MATTERMOST_WEBHOOK_URL = process.env.MATTERMOST_WEBHOOK_URL

if (!RESTAURANT_ID || !MEAL_TIME_ID) {
  throw new Error('RESTAURANT_ID / MEAL_TIME_ID environment variables are required.')
}
if (!MATTERMOST_WEBHOOK_URL) {
  throw new Error('MATTERMOST_WEBHOOK_URL environment variable is required.')
}

await postLunchMenu({
  restaurantId: RESTAURANT_ID,
  restaurantName: RESTAURANT_NAME,
  mealTimeId: MEAL_TIME_ID,
  mattermostWebhookUrl: MATTERMOST_WEBHOOK_URL,
  welstoryUsername: process.env.WELSTORY_USERNAME,
  welstoryPassword: process.env.WELSTORY_PASSWORD,
})
