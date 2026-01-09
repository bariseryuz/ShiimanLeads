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