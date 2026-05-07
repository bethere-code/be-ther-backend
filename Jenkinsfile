pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
  }

  environment {
    COMPOSE_FILE = "docker-compose.prod.yml"
    DEPLOY_DIR = "/opt/be-ther/be-ther-backend"
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Install') {
      steps {
        sh 'npm ci'
      }
    }

    stage('Lint') {
      steps {
        sh 'npm run lint'
      }
    }

    stage('Typecheck') {
      steps {
        sh 'npm run typecheck'
      }
    }

    stage('Build App') {
      steps {
        sh 'npm run build'
      }
    }

    stage('Deploy Containers') {
      steps {
        sh '''
          set -e
          test -f .env.production
          docker compose -f ${COMPOSE_FILE} up -d --build
        '''
      }
    }

    stage('Health Check') {
      steps {
        sh '''
          set -e
          sleep 5
          curl --fail --silent http://127.0.0.1:3000/health >/dev/null
        '''
      }
    }
  }

  post {
    success {
      sh 'docker compose -f ${COMPOSE_FILE} ps'
    }
    failure {
      sh 'docker compose -f ${COMPOSE_FILE} logs --tail=150 || true'
    }
  }
}
