// Fetches today's Multicampus lunch menu and writes a markdown preview file,
// without posting to Mattermost. Also prints RESTAURANT_ID / MEAL_TIME_ID for setup.

import 'dotenv/config'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MealTime, Menu, Restaurant } from '@pmh-only/welplan2-model'
import { WelstoryPlusClient } from '@pmh-only/welplan2-welstory-plus'

const SEARCH_KEYWORD = '멀티캠퍼스'
const LUNCH_KEYWORD = '점심'

const PREVIEW_FILE = path.join(process.cwd(), 'preview.md')

function todayYYYYMMDD(): string {
  const kstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }))
  const year = kstNow.getFullYear()
  const month = String(kstNow.getMonth() + 1).padStart(2, '0')
  const day = String(kstNow.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
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
      console.error(`   -> Failed to fetch side dish details for '${menu.name}', using basic components:`, err)
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
    console.error('   -> Failed to fetch course labels (courseTxt), proceeding without labels:', err)
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
// Images link directly to Welstory's CDN (same source production will use).
function formatMenuMessage(
  menus: Menu[],
  dateLabel: string,
  restaurantName: string,
  courseLabels: Map<string, string>
): string {
  if (menus.length === 0) {
    return `### 📅 ${dateLabel} ${restaurantName} 점심 식단\n\n오늘은 등록된 식단이 없습니다.`
  }

  const titles = menus.map((menu) => {
    const key = menuKey(menu)
    return escapeTableCell((key ? courseLabels.get(key) : undefined) ?? menu.name)
  })
  const imageCells = menus.map((menu, i) =>
    menu.imageUrl ? `<img src="${menu.imageUrl}" width="200" height="200" alt="${titles[i]}">` : ''
  )

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

async function main(): Promise<void> {
  const username = process.env.WELSTORY_USERNAME
  const password = process.env.WELSTORY_PASSWORD

  if (!username || !password) {
    console.error('WELSTORY_USERNAME / WELSTORY_PASSWORD environment variables are required. (check .env)')
    process.exit(1)
  }

  const client = new WelstoryPlusClient({ username, password })

  console.log(`1) Searching for '${SEARCH_KEYWORD}'...`)
  const found = await client.searchRestaurants(SEARCH_KEYWORD)

  if (found.length === 0) {
    console.error(`No restaurant found matching '${SEARCH_KEYWORD}'.`)
    process.exit(1)
  }

  const restaurant: Restaurant = found[0]
  console.log(`   -> Found: ${restaurant.name} (id: ${restaurant.id})`)

  console.log('2) Checking registration status...')
  const myList = await client.getRestaurants()
  const isRegistered = myList.some((r) => r.id === restaurant.id)
  if (!isRegistered) {
    console.log('   -> Not registered, registering...')
    await client.addRestaurant(restaurant.id)
  } else {
    console.log('   -> Already registered')
  }

  console.log('3) Fetching meal times...')
  const mealTimes: MealTime[] = await client.getMealTimes(restaurant)
  for (const mealTime of mealTimes) {
    console.log(`   - ${mealTime.name} (id: ${mealTime.id}, type: ${mealTime.type ?? '-'})`)
  }

  const lunchTime = mealTimes.find((m) => m.name.includes(LUNCH_KEYWORD) || m.type === 'lunch')
  if (!lunchTime) {
    console.error(`No meal time found matching '${LUNCH_KEYWORD}'.`)
    process.exit(1)
  }
  console.log(`   -> Selected lunch (${LUNCH_KEYWORD}): ${lunchTime.name} (id: ${lunchTime.id})`)

  const date = todayYYYYMMDD()
  console.log(`4) Fetching menu for ${date}...`)
  const menus = await client.getMenus(restaurant, date, lunchTime.id)

  console.log('5) Fetching side dish details per course...')
  const enrichedMenus = await enrichMenusWithDetails(client, restaurant, date, lunchTime.id, menus)

  console.log('6) Fetching course labels (courseTxt)...')
  const courseLabels = await fetchCourseLabels(client, restaurant, date, lunchTime.id)

  const dateLabel = `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}`
  const message = formatMenuMessage(enrichedMenus, dateLabel, restaurant.name, courseLabels)

  await writeFile(PREVIEW_FILE, message + '\n', 'utf-8')
  console.log(`\nPreview saved to ${PREVIEW_FILE} (not sent to Mattermost)`)
  console.log('Open it with a Markdown preview (e.g. in VSCode) to see it close to the real message.\n')

  console.log(`Note: this restaurant's RESTAURANT_ID=${restaurant.id}, MEAL_TIME_ID=${lunchTime.id}`)
  console.log('Set these two values via `firebase functions:config:set` / params when deploying the Cloud Function.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
