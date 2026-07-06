// noinspection JSUnresolvedFunction,JSIgnoredPromiseFromCall

import * as core from '@actions/core'
import fs from 'fs'
import * as github from '@actions/github'
import shell from 'shelljs'
import * as fvtt from '@foundryvtt/foundryvtt-cli'

const actionToken = core.getInput('actionToken')
const manifestFileName = core.getInput('manifestFileName')
const manifestProtectedTrue = core.getInput('manifestProtectedTrue')
const publicRepositoryAndBranch = core.getInput('publicRepositoryAndBranch')
const octokit = github.getOctokit(actionToken)
const owner = github.context.payload.repository.owner.login
const repo = github.context.payload.repository.name
const committerEmail = github.context.payload.head_commit.committer.email
const committerUsername = github.context.payload.head_commit.committer.username
const zipName = `${github.context.payload.repository.name}.zip`

async function compilePacks (data) {
  try {
    // Check if packs directory exists
    if (!fs.existsSync('packs')) {
      console.log('No packs directory found, skipping pack compilation')
      return
    }

    // Parse the JSON data
    data = JSON.parse(data)

    // Get the packs from the module
    const packs = data.packs || []

    // Process each pack
    for (const pack of packs) {
      const packName = pack.name
      if (packName) {
        const packSrcDir = `packs/${packName}/src`
        console.log(packSrcDir)
        try {
          const files = fs.readdirSync(packSrcDir)
          if (files.length !== 0) {
            // Compile the JSON file to LevelDB
            await fvtt.compilePack(`packs/${packName}/src`, `packs/${packName}`)
          }
        } catch {
          console.log(`Pack ${packName} src not found`)
        }
      }
    }
    await shell.exec('git add -f packs/*')
  } catch (err) {
    console.error('Error processing packs:', err)
  }
}

async function createRelease (versionNumber, releaseNotes) {
  try {
    return await octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: `${versionNumber}`,
      name: `${versionNumber}`,
      body: `Release ${versionNumber}\n\n## Release Notes:\n${releaseNotes}`,
      draft: true
    })
  } catch (error) {
    core.setFailed(error.message)
  }
}

async function getReleaseNotes () {
  try {
    // Get The Latest Release to bound the notes. The very first release has no
    // predecessor, so getLatestRelease 404s — fall back to every merged PR
    // rather than failing the run.
    let since
    try {
      console.log(`Get Latest Release for ${owner}/${repo}`)
      const latestRelease = await octokit.rest.repos.getLatestRelease({
        owner,
        repo
      })
      since = latestRelease.data.created_at
    } catch (error) {
      if (error.status === 404) {
        console.log('No previous release found; including all merged PRs in the release notes.')
      } else {
        throw error
      }
    }

    // One tight bullet per merged PR — not per commit. The PR title already
    // carries the issue reference by convention (e.g. "fix(sheet): ... (#779)"),
    // so appending the PR number gives both the issue and PR refs, and the PR
    // author is the implementor. Assembling from PRs keeps each feature to a
    // single line instead of dumping multi-line squash-commit bodies.
    console.log(`Get Merged Pull Requests for ${owner}/${repo}`)
    const pullList = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'closed',
      base: github.context.payload.repository.default_branch,
      sort: 'updated',
      direction: 'desc',
      per_page: 100
    })

    let releaseNotesMarkdown = ''
    pullList.data
      // Only PRs merged since the last release (ISO 8601 UTC strings compare
      // lexicographically == chronologically). Closed-but-not-merged PRs and
      // anything from a prior release are dropped.
      .filter((pull) => pull.merged_at && (!since || pull.merged_at > since))
      // Newest merge first.
      .sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1))
      .forEach((pull) => {
        releaseNotesMarkdown += `* ${pull.title} (#${pull.number}) — @${pull.user.login}\n`
      })

    return releaseNotesMarkdown
  } catch (error) {
    // The release notes are cosmetic — never fail the release because they
    // could not be built. Log the problem and ship the release with empty notes.
    console.log(error)
    return ''
  }
}

async function uploadAssets (releaseResponse) {
  try {
    // Upload Zip
    const zipData = await fs.readFileSync(zipName)
    await octokit.rest.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id: releaseResponse.data.id,
      name: zipName,
      data: zipData
    })

    // Upload Manifest
    const manifestData = fs.readFileSync(manifestFileName, 'utf-8')
    await octokit.rest.repos.uploadReleaseAsset({
      owner,
      repo,
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
    if (manifestFileName !== 'system.json' && manifestFileName !== 'module.json') {
      core.setFailed('manifestFileName must be system.json or module.json')
      return
    }

    // Get versionNumber from version.txt
    let versionNumber = fs.readFileSync('version.txt', 'utf-8')
    versionNumber = `v${versionNumber.trim()}`

    // Set up Download / Manifest URLs.
    //
    // BOTH the `download` and `manifest` URLs are per-version, pointing at this
    // release's immutable assets. Foundry's Package Release API validates the
    // manifest's self-referential `manifest` field when promoting a release to
    // the package's installable "current version". A MOVING manifest URL (e.g.
    // a `latest.json` on the default branch) is accepted by the API but the
    // validator refuses to promote it, which silently freezes the in-app
    // installer on the last release that used a versioned manifest. So the
    // `manifest` field MUST point to this exact version's `system.json` /
    // `module.json` release asset.
    //
    //   - Protected modules: the non-versioned root manifest published to the
    //     public content repo (publicRepositoryAndBranch), refreshed each release
    //     by foundry-release-upload-action.
    let downloadURL = `https://github.com/${owner}/${repo}/releases/download/${versionNumber}/${repo}.zip`
    let manifestURL = `https://github.com/${owner}/${repo}/releases/download/${versionNumber}/${manifestFileName}`
    let manifestProtectedValue = 'false'
    if (manifestProtectedTrue === 'true') {
      downloadURL = ''
      manifestURL = `https://raw.githubusercontent.com/${publicRepositoryAndBranch}/${repo}/${manifestFileName}`
      manifestProtectedValue = 'true'
    }

    // Replace Data in Manifest
    fs.readdirSync('.').forEach(file => {
      console.log(file)
    })
    const data = fs.readFileSync(manifestFileName, 'utf8')

    const formatted = data
      .replace(/"version": .*,/i, `"version": "${versionNumber.replace('v', '')}",`)
      .replace(/"download": .*,/i, `"download": "${downloadURL}",`)
      .replace(/"manifest": .*,/i, `"manifest": "${manifestURL}",`)
      .replace(/"protected": .*,/i, `"protected": ${manifestProtectedValue},`)
    fs.writeFileSync(manifestFileName, formatted, 'utf8')

    // Create Foundry LevelDB Files from JSON
    console.log('Compiling packs...')
    await compilePacks(data)

    // Assemble Release Notes from PRs Merged Since Last Release
    console.log('Get Release Notes')
    const releaseNotes = await getReleaseNotes()

    // Create Release
    console.log('Create Release')
    const releaseResponse = await createRelease(versionNumber, releaseNotes)
    await shell.exec(`git config user.email '${committerEmail}'`)
    await shell.exec(`git config user.name '${committerUsername}'`)
    await shell.exec(`git commit -am 'Release ${versionNumber}'`)
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
