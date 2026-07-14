// One-off script to find the restaurantId and lunch mealTimeId for Multicampus.
// getRestaurants() only returns restaurants already registered to the account,
// so we search first and register if needed.

import 'dotenv/config'
import { WelstoryPlusClient } from '@pmh-only/welplan2-welstory-plus'

const SEARCH_KEYWORD = '멀티캠퍼스'

async function main(): Promise<void> {
  const username = process.env.WELSTORY_USERNAME
  const password = process.env.WELSTORY_PASSWORD

  if (!username || !password) {
    console.error('WELSTORY_USERNAME / WELSTORY_PASSWORD environment variables are required.')
    process.exit(1)
  }

  const client = new WelstoryPlusClient({ username, password })

  console.log(`Searching for '${SEARCH_KEYWORD}'...`)
  const found = await client.searchRestaurants(SEARCH_KEYWORD)

  if (found.length === 0) {
    console.error(`No restaurant found matching '${SEARCH_KEYWORD}'.`)
    process.exit(1)
  }

  for (const restaurant of found) {
    console.log(`\nFound restaurant`)
    console.log(`  - name: ${restaurant.name}`)
    console.log(`  - id: ${restaurant.id}`)

    const myList = await client.getRestaurants()
    const isRegistered = myList.some((r) => r.id === restaurant.id)

    if (!isRegistered) {
      console.log('  - Not registered yet, registering...')
      await client.addRestaurant(restaurant.id)
    } else {
      console.log('  - Already registered.')
    }

    const mealTimes = await client.getMealTimes(restaurant)
    console.log(`  - Meal times:`)
    for (const mealTime of mealTimes) {
      console.log(`      - ${mealTime.name} (id: ${mealTime.id}, type: ${mealTime.type ?? '-'})`)
    }
  }

  console.log(
    '\nUse the restaurant id and the "점심" (lunch) mealTimeId above to set RESTAURANT_ID and MEAL_TIME_ID in GitHub Secrets.'
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
