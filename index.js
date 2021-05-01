// noinspection JSUnresolvedFunction,JSIgnoredPromiseFromCall

const core = require('@actions/core')
const github = require('@actions/github')
const shell = require('shelljs')
const fs = require('fs')

const manifestFileName = core.getInput('manifestFileName')
const actionToken = core.getInput('actionToken')
const octokit = github.getOctokit(actionToken)
const owner = github.context.payload.repository.owner.login
const repo = github.context.payload.repository.name
const committer_email = github.context.payload.head_commit.committer.email
const committer_username = github.context.payload.head_commit.committer.username
const zipName = `${github.context.payload.repository.name}.zip`

async function createRelease (versionNumber, commitLog) {
  try {
    return await octokit.rest.repos.createRelease({
      owner: owner,
      repo: repo,
      tag_name: `${versionNumber}`,
      name: `${versionNumber}`,
      body: `Release ${versionNumber}\n\n## Release Notes:\n${commitLog}`,
      draft: true,
    })
  } catch (error) {
    core.setFailed(error.message)
  }
}

async function getCommitLog () {
  try {
    // Get Latest Release
    const latestRelease = await octokit.rest.repos.getLatestRelease({
      owner: owner,
      repo: repo,
    })

    // Get Commits Since That Release's Date
    const commitList = await octokit.rest.repos.listCommits({
      owner: owner,
      per_page: 100,
      repo: repo,
      since: latestRelease.created_at,
    })
    console.log('COMMITS SINCE THAT TAG DATE')
    console.log(commitList)
    commitList.data.forEach(commit => {
      console.log(`* ${commit.commit.committer.name} - ${commit.commit.message}`)
    })

    return commitList
  } catch (error) {
    core.setFailed(error.message)
  }
}

async function uploadAssets (releaseResponse) {
  try {
    // Upload Zip
    const zipData = await fs.readFileSync(zipName)
    await octokit.rest.repos.uploadReleaseAsset({
      owner: owner,
      repo: repo,
      release_id: releaseResponse.data.id,
      name: zipName,
      data: zipData
    })

    // Upload Manifest
    const manifestData = await fs.readFileSync(manifestFileName, 'utf-8')
    await octokit.rest.repos.uploadReleaseAsset({
      owner: owner,
      repo: repo,
      release_id: releaseResponse.data.id,
      name: manifestFileName,
      data: manifestData
    })
  } catch (error) {
    core.setFailed(error.message)
  }
}

async function run () {
  try {
    // Validate manifestFileName
    if (manifestFileName !== 'system.json' && manifestFileName !== 'module.json')
      core.setFailed('manifestFileName must be system.json or module.json')

    // Get versionNumber from version.txt
    let versionNumber = await fs.readFileSync('version.txt', 'utf-8')
    versionNumber = `v${versionNumber.trim()}`

    // Replace Data in Manifest
    const data = fs.readFileSync(manifestFileName, 'utf8')
    const downloadURL = `https://github.com/${owner}/${repo}/releases/download/${versionNumber}/${repo}.zip`
    const manifestURL = `https://github.com/${owner}/${repo}/releases/download/${versionNumber}/system.json`
    const formatted = data
      .replace(/{{VERSION}}/g, versionNumber.replace('v', ''))
      .replace(/{{DOWNLOAD_URL}}/g, downloadURL)
      .replace(/{{MANIFEST_URL}}/g, manifestURL)
    fs.writeFileSync('system.json', formatted, 'utf8')

    // Git List of Commits Since Last Release
    const commitLog = await getCommitLog()

    // Create Release
    const releaseResponse = await createRelease(versionNumber, commitLog)
    await shell.exec(`git config user.email "${committer_email}"`)
    await shell.exec(`git config user.name "${committer_username}"`)
    await shell.exec(`git commit -am "Release ${versionNumber}"`)
    await shell.exec(`git archive -o ${zipName} HEAD`)
    await uploadAssets(releaseResponse)

    // Log Results
    console.log(`**** Version ${versionNumber} Release Created!`)
    console.log('**** URLs Embedded in Manifest:')
    console.log(`** Download URL: ${downloadURL}`)
    console.log(`** Manifest URL: ${manifestURL}`)

  } catch (error) {
    core.setFailed(error.message)
  }
}

run()