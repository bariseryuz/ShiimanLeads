# 🚂 Deploy to Railway - www.shiimanleads.com

## 📋 Prerequisites
- [x] Railway account (sign up at railway.app)
- [x] GitHub account
- [x] Google Gemini API key (get from ai.google.dev)
- [x] Domain: www.shiimanleads.com

---

## 🚀 Step-by-Step Deployment

### **Step 1: Push Code to GitHub**

1. **Initialize Git** (if not already):
```bash
cd "C:\Users\fa-de\Desktop\data-based lead generation\shiiman-leads"
git init
git add .
git commit -m "Initial commit - Shiiman Leads v1.0"
```

2. **Create GitHub Repository**:
   - Go to github.com
   - Click "New repository"
   - Name: `shiiman-leads`
   - Don't initialize with README (we already have code)
   - Click "Create repository"

3. **Push to GitHub**:
```bash
git remote add origin https://github.com/YOUR_USERNAME/shiiman-leads.git
git branch -M main
git push -u origin main
```

---

### **Step 2: Deploy on Railway**

1. **Go to Railway**:
   - Visit: https://railway.app
   - Sign in with GitHub

2. **Create New Project**:
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose `shiiman-leads` repository
   - Railway will auto-detect Node.js and use nixpacks.toml

3. **Wait for Initial Deploy**:
   - Railway will build and deploy automatically
   - This may take 3-5 minutes
   - ⚠️ It will fail first time (we need environment variables)

---

### **Step 3: Configure Environment Variables**

1. **In Railway Dashboard**:
   - Click on your deployed service
   - Go to "Variables" tab
   - Add these variables:

```
GEMINI_API_KEY=your_actual_gemini_key
SESSION_SECRET=generate_random_32_character_string
NODE_ENV=production
```

2. **Get Gemini API Key**:
   - Go to: https://ai.google.dev/
   - Click "Get API Key"
   - Create new key
   - Copy and paste into Railway

3. **Generate Session Secret**:
   - Use a password generator
   - Or run in PowerShell:
   ```powershell
   -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | % {[char]$_})
   ```

4. **Click "Redeploy"** after adding variables

---

### **Step 4: Connect Custom Domain**

1. **In Railway Dashboard**:
   - Go to "Settings" tab
   - Scroll to "Domains"
   - Click "Add Domain"
   - Enter: `www.shiimanleads.com`

2. **Get Railway DNS Info**:
   - Railway will show you DNS records
   - You'll see something like:
     - CNAME: `your-app.railway.app`

3. **Update Your Domain DNS** (at your domain registrar):
   - Go to your domain registrar (GoDaddy, Namecheap, etc.)
   - Find DNS settings
   - Add/Update CNAME record:
     ```
     Type: CNAME
     Name: www
     Value: your-app.railway.app (from Railway)
     TTL: Automatic or 3600
     ```
   - Also add for root domain if needed:
     ```
     Type: CNAME
     Name: @
     Value: www.shiimanleads.com
     ```

4. **Wait for DNS Propagation**:
   - Usually takes 5-60 minutes
   - Can take up to 24-48 hours max
   - Check status at: https://dnschecker.org

---

### **Step 5: Verify Deployment**

Once DNS is ready, visit:
- ✅ https://www.shiimanleads.com
- ✅ Create a test account
- ✅ Add a Zillow source
- ✅ Check if scraping works

---

## 🔧 Post-Deployment Configuration

### **Enable HTTPS (Automatic)**
Railway automatically provides SSL certificates. Your site will be:
- `https://www.shiimanleads.com` ✅

### **Monitor Logs**
- In Railway Dashboard → "Deployments" → "View Logs"
- Check for any errors

### **Database**
- SQLite database is created automatically
- Data persists in Railway's storage
- Located at: `backend/leads.db`

---

## 🔄 Future Updates

When you make changes:

```bash
git add .
git commit -m "Description of changes"
git push origin main
```

Railway will automatically:
- Detect the push
- Rebuild the app
- Deploy new version
- Zero downtime!

---

## 🐛 Troubleshooting

### **App won't start:**
- Check Railway logs
- Verify environment variables are set
- Make sure GEMINI_API_KEY is valid

### **Can't access website:**
- Check DNS settings
- Wait longer for DNS propagation
- Try clearing browser cache
- Test with: `nslookup www.shiimanleads.com`

### **Scraping not working:**
- Check Railway logs for Puppeteer errors
- Verify Chromium is installed (nixpacks.toml handles this)
- Some sites may block Railway IPs

### **Database issues:**
- Check if `leads.db` file exists in Railway storage
- Verify write permissions
- Check Railway logs for SQL errors

---

## 📊 Railway Dashboard Overview

**Metrics to Watch:**
- CPU usage
- Memory usage
- Request count
- Error rate

**Useful Tabs:**
- **Deployments**: See all deployments and logs
- **Metrics**: Monitor performance
- **Variables**: Environment variables
- **Settings**: Domain, scaling, etc.

---

## 💰 Railway Pricing

**Free Tier:**
- $5 credit per month
- Good for testing and development

**Pro Plan** (if needed):
- $5/month usage-based
- Scales automatically
- Better for production

---

## ✅ Final Checklist

- [ ] Code pushed to GitHub
- [ ] Railway project created
- [ ] Environment variables set
- [ ] App deployed successfully
- [ ] Custom domain added
- [ ] DNS configured
- [ ] HTTPS working
- [ ] Test account created
- [ ] Zillow source added
- [ ] Scraping tested

---

## 🎉 You're Live!

Your lead generation system is now live at:
**https://www.shiimanleads.com**

Start generating leads! 🚀

---

## 📞 Need Help?

- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- Your error logs: Railway Dashboard → Deployments → Logs
