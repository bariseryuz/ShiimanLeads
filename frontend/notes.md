Changed session store from local to sqlite 
Locally checked the preserved log on incognito mode there was login issue

so I check thed terminal powershell 
- It does see the login attemps and checks the username (database) and then checks if the passweord is correct or not 
it sets session for user 
it logged me in 
it authenticated me 
uses api/me to authenticate 
checks if I have sources to scrape 
when I try to attempt to reaxh dashboard it sees it and it authenticates me 


checked to see if the session was saved locally or on sqlite 

Test-Path "C:\Users\fa-de\Desktop\data-based lead generation\shiiman-leads\backend\data\sessions.db"
(did this test path) = Result was "true"

sqlite3 "C:\Users\fa-de\Desktop\data-based lead generation\shiiman-leads\backend\data\sessions.db" "SELECT sess FROM sessions LIMIT 1;"
(the this) result was "{"cookie":{"originalMaxAge":86400000,"expires":"2026-01-09T14:38:09.039Z","secure":false,"httpOnly":true,"path":"/","sameSite":"lax"},"user":{"id":2,"username":"bariseryuz","role":"client"}}"

so session is being saved on sqlite we verified it .

I STILL CAN'T NAVIGATE TO Profike and Sourves  WHEN I DO I SEE BLACK SCREEN SO 
-Vhecked the html for that 
- Checked if it is a javascript issue
- Checkd the correct path just in case 
-It does not reaad the css detailşs
-Page had 2 confilct parts
-Profile and Sources are in the same spot so it might be causing the conflict as well
-created extra proifle and sources htmls and linked them to correct opaths
ISSUE RESOLVED


RAILWAY SAYS SERVER:JS EXITED
-updated railway.json to use node index.js instead of node start.js
-Fixed nixpacks.toml to run index.js instead of server.js" the nixpack  was overriiding

Things that will gbe fixed on 12.01.26 
-Layout on the mobile view on deployed website.
-Needed to be focused on the correct data adding issue.
-Icons have been replaced.
-Better UI/UX experience.
 

 13.01.2025 

 Entered data fır redfin is not pulling data when addedc from the website:
 -
 E-mail config.
 Data improvement

16.01 
-Data is not being pılled when clickled on scrape now button. 
-Checked scrape now button to see if it works it does work 
-I can see the profile loaded for user 5 and it found 1 source, but I don't see the "Manual scrape triggered" log message. This means the "Scrape Now" button might not be hitting the endpoint. Let me check the frontend code:
The "Scrape Now" button is working - it's hitting the server.js endpoint and getting a success message. But server.js doesn't actually scrape, it just says "scraping will happen automatically every 8 hours."

basically scarpe was calling server.js instead of index.js


I have been getting no soıurce configured when clicked on the button after doing the changes 
The issue is clear now - server.js is using a different database file than index.js!

changed the data route on server.js 
copied user data from leads.db to data/leads.dbü

added the data website with infinite scrolling so added the code for it 



